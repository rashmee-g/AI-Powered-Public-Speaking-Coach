from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
import wave
from collections import Counter
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.services.emotion_service import analyze_emotion_frame
from backend.services.pose_service import analyze_pose_frame
from backend.services.speech_service import SessionStats, analyze
from backend.services.ai_feedback_service import generate_ai_feedback
from backend.services import content_service
from backend.db import sessions_collection, users_collection


app = FastAPI(title="AI Public Speaking Coach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSIONS: dict[str, dict[str, Any]] = {}


def clamp_score(value: float) -> int:
    return max(0, min(100, int(round(value))))


def score_to_letter(score: float) -> str:
    if score >= 85:
        return "A"
    if score >= 80:
        return "B+"
    if score >= 75:
        return "B"
    if score >= 65:
        return "C+"
    if score >= 55:
        return "C"
    if score >= 40:
        return "D"
    return "F"


def build_session_grade(
    overall_score: float,
    speech_score: float,
    content_score: float,
    body_score: float,
    emotion_score: float,
) -> dict[str, Any]:
    score = clamp_score(overall_score)
    return {
        "score": score,
        "letter": score_to_letter(score),
        "breakdown": {
            "speech": clamp_score(speech_score),
            "content": clamp_score(content_score),
            "body": clamp_score(body_score),
            "emotion": clamp_score(emotion_score),
        },
        "summary": f"Average across all coaching categories: {score}/100.",
    }


def normalize_text(value: str | None) -> str:
    return " ".join(str(value or "").strip().lower().split())


def build_session_group_id(
    title: str | None,
    expected_text: str | None,
    key_points: list[str] | None,
) -> str:
    normalized_payload = {
        "title": normalize_text(title),
        "expected_text": normalize_text(expected_text),
        "key_points": sorted(
            normalize_text(point) for point in (key_points or []) if normalize_text(point)
        ),
    }
    raw = json.dumps(normalized_payload, sort_keys=True)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, raw))


def get_group_id_for_record(record: dict[str, Any]) -> str:
    existing = str(record.get("session_group_id") or "").strip()
    if existing:
        return existing
    return build_session_group_id(
        record.get("title"),
        record.get("expected_text"),
        record.get("key_points", []),
    )


def transcript_preview(value: str | None, limit: int = 110) -> str:
    cleaned = " ".join(str(value or "").split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 3].rstrip()}..."


# -----------------------------
# Request models
# -----------------------------
class StartSessionRequest(BaseModel):
    username: str
    title: str | None = None
    session_group_id: str | None = None
    expected_text: str = ""
    key_points: list[str] = Field(default_factory=list)


class FrameRequest(BaseModel):
    session_id: str
    image_base64: str


class AudioRequest(BaseModel):
    session_id: str
    audio_base64: str
    sample_rate: int = 16000


class ContentRequest(BaseModel):
    session_id: str
    transcript: str | None = None
    expected_text: str | None = None
    key_points: list[str] | None = None


class SignupRequest(BaseModel):
    name: str
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


# -----------------------------
# Helpers
# -----------------------------
def decode_base64_image(image_base64: str) -> np.ndarray:
    try:
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_base64)
        np_arr = np.frombuffer(image_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if frame is None:
            raise ValueError("Could not decode image.")

        return frame
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")


def decode_base64_audio_to_float32(audio_base64: str) -> np.ndarray:
    try:
        if "," in audio_base64:
            audio_base64 = audio_base64.split(",", 1)[1]

        audio_bytes = base64.b64decode(audio_base64)
        audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)

        if audio_int16.size == 0:
            raise ValueError("Audio chunk is empty.")

        return audio_int16.astype(np.float32) / 32768.0
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid audio data: {e}")


def convert_uploaded_audio_to_wav_16k_mono(input_path: str) -> str:
    output_path = tempfile.mktemp(suffix=".wav")

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        input_path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        output_path,
    ]

    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="ffmpeg is not installed. Install it with: brew install ffmpeg",
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Audio conversion failed: {e.stderr.decode(errors='ignore')}",
        )

    return output_path


def load_wav_to_float32(wav_path: str) -> np.ndarray:
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()

        if n_channels != 1:
            raise HTTPException(status_code=400, detail="Expected mono WAV audio.")
        if sampwidth != 2:
            raise HTTPException(status_code=400, detail="Expected 16-bit WAV audio.")
        if framerate != 16000:
            raise HTTPException(status_code=400, detail="Expected 16kHz WAV audio.")

        frames = wf.readframes(n_frames)
        audio_int16 = np.frombuffer(frames, dtype=np.int16)

        return audio_int16.astype(np.float32) / 32768.0


def write_temp_wav(audio: np.ndarray, sample_rate: int) -> str:
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)

    pcm16 = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm16 * 32767).astype(np.int16)

    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())

    return path


def require_session(session_id: str) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


def default_pose_state() -> dict[str, Any]:
    return {
        "prev_left_wrist": None,
        "fidget_score": 0.0,
        "head_positions": [],
        "hip_positions": [],
    }


def choose_live_tip(
    speech_headline: str | None,
    body_feedback: list[str],
    emotion: str,
    content_tip: str | None = None,
    topic_status: str | None = None,
) -> str:
    if topic_status == "topic_drift" and content_tip:
        return content_tip

    if speech_headline and speech_headline.strip() and speech_headline != "Good delivery overall.":
        return speech_headline

    if body_feedback:
        return body_feedback[0]

    if emotion not in ("...", "", "neutral", "unknown"):
        return f"Facial emotion detected: {emotion}"

    return "Good job — keep going."


def compute_speech_score(speech_summary: dict[str, Any]) -> int:
    windows = int(speech_summary.get("windows", 0) or 0)
    issue_counts = speech_summary.get("issue_counts", {}) or {}
    medians = speech_summary.get("medians", {}) or {}
    baseline = speech_summary.get("baseline", {}) or {}

    alert_count = sum(
        int(count or 0)
        for key, count in issue_counts.items()
        if str(key).endswith("_alert")
    )
    watch_count = sum(
        int(count or 0)
        for key, count in issue_counts.items()
        if str(key).endswith("_watch")
    )

    if windows <= 0:
        score = 72 - (alert_count * 6) - (watch_count * 3)
        return clamp_score(score)

    estimated_wpm = float(medians.get("estimated_wpm", 0.0) or 0.0)
    avg_dbfs = float(medians.get("avg_dbfs", 0.0) or 0.0)
    snr_db = float(medians.get("snr_db", 0.0) or 0.0)
    pitch_range_hz = float(medians.get("pitch_range_hz", 0.0) or 0.0)
    silence_pct = float(medians.get("silence_pct", 0.0) or 0.0)

    baseline_wpm = float(baseline.get("baseline_wpm", 145.0) or 145.0)
    baseline_dbfs = float(baseline.get("baseline_dbfs", -24.0) or -24.0)
    baseline_pitch = float(baseline.get("baseline_pitch", 40.0) or 40.0)
    baseline_silence = float(baseline.get("baseline_silence_pct", 18.0) or 18.0)

    fast_wpm = max(185.0, baseline_wpm + 25.0)
    slow_wpm = min(110.0, max(90.0, baseline_wpm - 35.0))
    loud_dbfs = max(-15.0, baseline_dbfs + 8.0)
    quiet_dbfs = baseline_dbfs - 8.0
    monotone_hz = min(25.0, max(15.0, baseline_pitch * 0.6))
    pause_heavy_pct = max(40.0, baseline_silence + 18.0)
    pause_dense_pct = min(8.0, max(4.0, baseline_silence - 10.0))

    score = 100

    if estimated_wpm > 0:
        if estimated_wpm > fast_wpm + 15 or estimated_wpm < slow_wpm - 15:
            score -= 14
        elif estimated_wpm > fast_wpm or estimated_wpm < slow_wpm:
            score -= 8

    if snr_db < 8:
        score -= 16
    elif avg_dbfs < quiet_dbfs or snr_db < 12:
        score -= 8
    elif avg_dbfs > loud_dbfs:
        score -= 6

    if pitch_range_hz > 0:
        if pitch_range_hz < max(10.0, monotone_hz * 0.65):
            score -= 14
        elif pitch_range_hz < monotone_hz:
            score -= 8
        elif pitch_range_hz < monotone_hz + 8:
            score -= 4

    if silence_pct >= pause_heavy_pct + 8:
        score -= 14
    elif silence_pct >= pause_heavy_pct:
        score -= 8
    elif silence_pct <= max(2.0, pause_dense_pct - 2):
        score -= 8
    elif silence_pct <= pause_dense_pct:
        score -= 4

    score -= (alert_count * 6) + (watch_count * 3)

    return clamp_score(score)


def compute_body_score(body_counts: Counter[str], frame_checks: int) -> int:
    if frame_checks <= 0:
        return 0

    penalty = min(sum(body_counts.values()) * 7, 55)
    score = 92 - penalty
    return clamp_score(score)


def compute_emotion_score(emotion_counts: Counter[str]) -> int:
    if not emotion_counts:
        return 0

    dominant_emotion = emotion_counts.most_common(1)[0][0]
    total = sum(emotion_counts.values())
    dominant_ratio = emotion_counts[dominant_emotion] / max(total, 1)

    base_map = {
        "happy": 88,
        "neutral": 82,
        "surprise": 80,
        "fear": 58,
        "sad": 55,
        "angry": 48,
        "disgust": 42,
    }
    base = base_map.get(dominant_emotion, 72)
    return clamp_score(base + (dominant_ratio * 8))


def compute_content_score(latest_content: dict[str, Any] | None) -> int:
    if not latest_content:
        return 0
    similarity = float(latest_content.get("similarity_score", 0.0) or 0.0)
    return clamp_score(similarity * 100 if similarity <= 1 else similarity)


def build_content_summary(
    content_history: list[dict[str, Any]],
    full_transcript: str,
    expected_text: str,
    key_points: list[str],
) -> dict[str, Any] | None:
    if not content_history and not full_transcript.strip():
        return None

    usable_entries = [
        entry for entry in content_history
        if isinstance(entry, dict)
        and (
            str(entry.get("transcript", "")).strip()
            or entry.get("similarity_score", 0)
            or entry.get("covered_points")
        )
    ]

    best_entry = None
    if usable_entries:
        best_entry = max(
            usable_entries,
            key=lambda entry: (
                float(entry.get("similarity_score", 0.0) or 0.0),
                len(entry.get("covered_points", []) or []),
                len(str(entry.get("transcript", "")).split()),
                float(entry.get("timestamp", 0.0) or 0.0),
            ),
        )

    latest_non_empty = None
    for entry in reversed(usable_entries):
        if str(entry.get("transcript", "")).strip():
            latest_non_empty = entry
            break

    aggregate = safe_content_analysis(
        transcript=full_transcript,
        expected_text=expected_text,
        key_points=key_points,
    ) if full_transcript.strip() and (expected_text or key_points) else {
        "transcript": full_transcript.strip(),
        "similarity_score": 0.0,
        "covered_points": [],
        "missed_points": key_points,
        "topic_status": "not_checked" if full_transcript.strip() else "no_content",
        "ai_content_tip": (
            "Transcript captured, but no planned script or key points were provided."
            if full_transcript.strip()
            else "Not enough spoken content yet."
        ),
    }

    base_entry = best_entry or latest_non_empty or {}

    summary = {
        **base_entry,
        **aggregate,
        "transcript": full_transcript.strip() or str(base_entry.get("transcript", "")).strip(),
        "latest_chunk_transcript": str(latest_non_empty.get("transcript", "")).strip() if latest_non_empty else "",
        "best_chunk_transcript": str(best_entry.get("transcript", "")).strip() if best_entry else "",
    }

    summary["overall_score"] = compute_content_score(summary)
    return summary


def safe_transcribe_audio(wav_path: str) -> tuple[str, str | None]:
    try:
        transcript = content_service.transcribe_audio(wav_path)
        print("TRANSCRIPT DEBUG:", repr(transcript))

        if not isinstance(transcript, str):
            return "", "Transcription returned a non-string result."

        return transcript.strip(), None
    except Exception as e:
        print("Transcription error:", e)
        return "", str(e)


def safe_content_analysis(
    transcript: str,
    expected_text: str,
    key_points: list[str],
) -> dict[str, Any]:
    try:
        result = content_service.analyze_content(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
        )

        if not isinstance(result, dict):
            return {
                "transcript": transcript,
                "similarity_score": 0.0,
                "missed_points": key_points,
                "topic_status": "error",
                "ai_content_tip": "Content analysis did not return structured feedback.",
            }

        return result
    except Exception as e:
        print("Content analysis error:", e)
        return {
            "transcript": transcript,
            "similarity_score": 0.0,
            "missed_points": key_points,
            "topic_status": "error",
            "ai_content_tip": f"Content analysis failed: {e}",
        }


def safe_ai_feedback(
    transcript: str,
    expected_text: str,
    key_points: list[str],
    metrics: dict[str, Any],
    fallback_live_tip: str,
) -> dict[str, str]:
    try:
        result = generate_ai_feedback(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
            metrics=metrics,
        )

        if not isinstance(result, dict):
            raise ValueError("AI feedback service did not return a dictionary.")

        return {
            "live_tip": result.get("live_tip", fallback_live_tip),
            "content_tip": result.get("content_tip", ""),
            "positive_note": result.get("positive_note", ""),
        }
    except Exception as e:
        print("AI feedback error:", e)
        return {
            "live_tip": fallback_live_tip,
            "content_tip": "",
            "positive_note": "",
        }


# -----------------------------
# Routes
# -----------------------------
@app.get("/")
def root():
    return {"message": "AI Public Speaking Coach backend is running."}


@app.get("/status")
def status():
    return {
        "status": "ok",
        "active_sessions": len(SESSIONS),
    }


@app.post("/session/start")
def start_session(payload: StartSessionRequest):
    session_id = str(uuid.uuid4())
    username = payload.username.strip().lower()
    session_group_id = (
        payload.session_group_id.strip()
        if payload.session_group_id and payload.session_group_id.strip()
        else build_session_group_id(payload.title, payload.expected_text, payload.key_points)
    )

    SESSIONS[session_id] = {
        "session_id": session_id,
        "session_group_id": session_group_id,
        "username": username,
        "title": payload.title,
        "created_at": time.time(),
        "expected_text": payload.expected_text,
        "key_points": payload.key_points,
        "speech_stats": SessionStats(),
        "frame_checks": 0,
        "emotion_log": [],
        "pose_state": default_pose_state(),
        "body_feedback_log": [],
        "latest_transcript": "",
        "chunk_transcripts": [],
        "content_history": [],
    }

    return {
        "session_id": session_id,
        "session_group_id": session_group_id,
        "status": "started",
    }


@app.get("/sessions")
async def list_completed_sessions(username: str):
    normalized_username = username.strip().lower()

    cursor = sessions_collection.find(
        {"status": "completed", "username": normalized_username},
        {
            "_id": 0,
            "session_id": 1,
            "session_group_id": 1,
            "username": 1,
            "created_at": 1,
            "updated_at": 1,
            "title": 1,
            "expected_text": 1,
            "key_points": 1,
            "overall_feedback": 1,
            "speech_summary": 1,
            "emotion_summary": 1,
            "body_summary": 1,
            "content_summary": 1,
            "overall_score": 1,
            "latest_transcript": 1,
            "transcript": 1,
            "session_grade": 1,
        },
    ).sort("created_at", -1)

    grouped_sessions: dict[str, dict[str, Any]] = {}

    async for item in cursor:
        group_id = get_group_id_for_record(item)
        attempt_grade = item.get("session_grade") or build_session_grade(
            item.get("overall_score", 0),
            item.get("speech_summary", {}).get("overall_score", 0),
            item.get("content_summary", {}).get("overall_score", 0),
            item.get("body_summary", {}).get("overall_score", 0),
            item.get("emotion_summary", {}).get("overall_score", 0),
        )
        attempt_summary = {
            "attempt_id": item.get("session_id"),
            "session_id": item.get("session_id"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "transcript_preview": transcript_preview(
                item.get("transcript") or item.get("latest_transcript")
            ),
            "latest_transcript": item.get("latest_transcript") or item.get("transcript") or "",
            "overall_score": attempt_grade.get("score", 0),
            "session_grade": attempt_grade,
        }

        if group_id not in grouped_sessions:
            grouped_sessions[group_id] = {
                "session_id": group_id,
                "session_group_id": group_id,
                "username": normalized_username,
                "title": item.get("title"),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
                "expected_text": item.get("expected_text", ""),
                "key_points": item.get("key_points", []),
                "overall_feedback": item.get("overall_feedback", []),
                "speech_summary": item.get("speech_summary", {}),
                "emotion_summary": item.get("emotion_summary", {}),
                "body_summary": item.get("body_summary", {}),
                "content_summary": item.get("content_summary", {}),
                "latest_attempt_id": item.get("session_id"),
                "attempts": [],
            }

        group = grouped_sessions[group_id]
        group["attempts"].append(attempt_summary)

        if (item.get("created_at") or 0) >= (group.get("created_at") or 0):
            group["title"] = item.get("title")
            group["created_at"] = item.get("created_at")
            group["updated_at"] = item.get("updated_at")
            group["expected_text"] = item.get("expected_text", "")
            group["key_points"] = item.get("key_points", [])
            group["overall_feedback"] = item.get("overall_feedback", [])
            group["speech_summary"] = item.get("speech_summary", {})
            group["emotion_summary"] = item.get("emotion_summary", {})
            group["body_summary"] = item.get("body_summary", {})
            group["content_summary"] = item.get("content_summary", {})
            group["latest_attempt_id"] = item.get("session_id")

    sessions: list[dict[str, Any]] = []
    for group in grouped_sessions.values():
        group["attempts"] = sorted(
            group["attempts"],
            key=lambda attempt: attempt.get("created_at") or 0,
            reverse=True,
        )
        attempt_scores = [
            attempt.get("session_grade", {}).get("score", 0) for attempt in group["attempts"]
        ]
        average_score = sum(attempt_scores) / max(len(attempt_scores), 1)
        group["attempt_count"] = len(group["attempts"])
        group["overall_score"] = clamp_score(average_score)
        group["session_grade"] = {
            "score": clamp_score(average_score),
            "letter": score_to_letter(average_score),
            "summary": f"Average across {len(group['attempts'])} attempts.",
        }
        sessions.append(group)

    sessions.sort(key=lambda item: item.get("created_at") or 0, reverse=True)
    return sessions


@app.get("/sessions/{session_id}")
async def get_session_report(session_id: str, username: str):
    normalized_username = username.strip().lower()

    session = await sessions_collection.find_one(
        {"session_id": session_id, "username": normalized_username},
        {"_id": 0},
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    return session


@app.post("/analyze/frame")
def analyze_frame(payload: FrameRequest):
    session = require_session(payload.session_id)
    frame = decode_base64_image(payload.image_base64)
    frame = cv2.flip(frame, 1)
    session["frame_checks"] = int(session.get("frame_checks", 0)) + 1

    try:
        emotion_raw = analyze_emotion_frame(frame)
    except Exception as e:
        print("Emotion analysis error:", e)
        emotion_raw = "unknown"

    pose_state = session.get("pose_state")
    if pose_state is None:
        pose_state = default_pose_state()
        session["pose_state"] = pose_state

    try:
        body_feedback = analyze_pose_frame(frame, pose_state)
    except Exception as e:
        print("Pose analysis error:", e)
        body_feedback = []

    if emotion_raw and emotion_raw not in ("...", "", "unknown"):
        session["emotion_log"].append(emotion_raw)

    if body_feedback:
        session["body_feedback_log"].extend(body_feedback)

    body_summary = "; ".join(body_feedback[:2]) if body_feedback else "No posture issues detected"

    live_tip = choose_live_tip(
        speech_headline=None,
        body_feedback=body_feedback,
        emotion=emotion_raw or "unknown",
    )

    return {
        "emotion": emotion_raw or "unknown",
        "body_feedback": body_feedback,
        "body_summary": body_summary,
        "live_tip": live_tip,
    }


@app.post("/analyze/audio")
def analyze_audio(payload: AudioRequest):
    session = require_session(payload.session_id)
    audio = decode_base64_audio_to_float32(payload.audio_base64)

    result = analyze(audio)

    if result is None:
        return {
            "status": {
                "overall": "Listening",
                "headline": "Keep speaking so I can analyze your delivery.",
            },
            "messages": [],
            "metrics": {},
            "live_tip": "Keep speaking so I can analyze your delivery.",
        }

    session["speech_stats"].add(result)

    return {
        "status": result["status"],
        "messages": result["messages"],
        "metrics": result["metrics"],
        "raw_alerts": result.get("raw_alerts", []),
        "live_tip": result["status"]["headline"],
    }


@app.post("/analyze/audio-chunk")
async def analyze_audio_chunk(
    session_id: str = Form(...),
    audio_file: UploadFile = File(...),
):
    session = require_session(session_id)

    suffix = os.path.splitext(audio_file.filename or "")[1] or ".m4a"
    fd, input_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)

    wav_path = None

    try:
        with open(input_path, "wb") as f:
            shutil.copyfileobj(audio_file.file, f)

        wav_path = convert_uploaded_audio_to_wav_16k_mono(input_path)
        audio = load_wav_to_float32(wav_path)

        duration_s = len(audio) / 16000.0
        max_amp = float(np.max(np.abs(audio))) if audio.size else 0.0

        transcript, transcription_error = safe_transcribe_audio(wav_path)

        try:
            result = analyze(audio)
        except Exception as e:
            print("Speech analyze() error:", e)
            result = None

        expected_text = session.get("expected_text", "")
        key_points = session.get("key_points", [])

        content_result = safe_content_analysis(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
        ) if transcript and (expected_text or key_points) else {
            "transcript": transcript,
            "similarity_score": 0.0,
            "covered_points": [],
            "missed_points": [],
            "topic_status": "not_checked" if transcript else "no_content",
            "ai_content_tip": (
                "Transcript captured, but no planned script or key points were provided."
                if transcript and not expected_text and not key_points
                else "Not enough spoken content yet."
            ),
        }

        if transcript:
            session["latest_transcript"] = transcript
            session["chunk_transcripts"].append(transcript)

        if result is None:
            session["content_history"].append({
                "transcript": transcript,
                "ai_content_tip": content_result.get("ai_content_tip", ""),
                "topic_status": content_result.get("topic_status", "no_content"),
                "similarity_score": content_result.get("similarity_score", 0.0),
                "covered_points": content_result.get("covered_points", []),
                "missed_points": content_result.get("missed_points", []),
                "timestamp": time.time(),
            })

            return {
                "status": {
                    "overall": "Listening",
                    "headline": "Keep speaking so I can analyze your delivery.",
                },
                "messages": [],
                "metrics": {
                    "duration_s": round(duration_s, 2),
                    "max_amp": round(max_amp, 4),
                },
                "live_tip": "Keep speaking so I can analyze your delivery.",
                "ai_content_tip": content_result.get("ai_content_tip", "Not enough spoken content yet."),
                "positive_note": "",
                "transcript": transcript,
                "similarity_score": content_result.get("similarity_score", 0.0),
                "covered_points": content_result.get("covered_points", []),
                "missed_points": content_result.get("missed_points", []),
                "topic_status": content_result.get("topic_status", "no_content"),
                "debug": {
                    "reason": "analyze_returned_none_or_failed",
                    "audio_duration_s": round(duration_s, 2),
                    "audio_samples": int(audio.size),
                    "transcription_error": transcription_error,
                },
            }

        session["speech_stats"].add(result)

        ai_feedback = safe_ai_feedback(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
            metrics=result["metrics"],
            fallback_live_tip=result["status"]["headline"],
        )

        if not ai_feedback.get("content_tip") and content_result.get("ai_content_tip"):
            ai_feedback["content_tip"] = content_result["ai_content_tip"]

        live_tip = choose_live_tip(
            speech_headline=ai_feedback.get("live_tip", result["status"]["headline"]),
            body_feedback=[],
            emotion="unknown",
            content_tip=content_result.get("ai_content_tip"),
            topic_status=content_result.get("topic_status"),
        )

        session["content_history"].append({
            "transcript": transcript,
            "ai_content_tip": ai_feedback.get("content_tip", ""),
            "positive_note": ai_feedback.get("positive_note", ""),
            "live_tip": live_tip,
            "topic_status": content_result.get("topic_status", "not_checked"),
            "similarity_score": content_result.get("similarity_score", 0.0),
            "covered_points": content_result.get("covered_points", []),
            "missed_points": content_result.get("missed_points", []),
            "timestamp": time.time(),
        })

        return {
            "status": result["status"],
            "messages": result["messages"],
            "metrics": result["metrics"],
            "raw_alerts": result.get("raw_alerts", []),
            "live_tip": live_tip,
            "ai_content_tip": ai_feedback.get("content_tip", ""),
            "positive_note": ai_feedback.get("positive_note", ""),
            "transcript": transcript,
            "similarity_score": content_result.get("similarity_score", 0.0),
            "covered_points": content_result.get("covered_points", []),
            "missed_points": content_result.get("missed_points", []),
            "topic_status": content_result.get("topic_status", "not_checked"),
            "debug": {
                "audio_duration_s": round(duration_s, 2),
                "max_amp": round(max_amp, 4),
                "transcription_error": transcription_error,
            },
        }

    except HTTPException:
        raise
    except Exception as e:
        print("Audio chunk route fatal error:", e)
        raise HTTPException(status_code=500, detail=f"Audio chunk analysis failed: {e}")
    finally:
        try:
            audio_file.file.close()
        except Exception:
            pass

        if os.path.exists(input_path):
            os.remove(input_path)

        if wav_path and os.path.exists(wav_path):
            os.remove(wav_path)


@app.post("/analyze/content")
def analyze_content_route(payload: ContentRequest):
    session = require_session(payload.session_id)

    expected_text = payload.expected_text or session["expected_text"]
    key_points = payload.key_points or session["key_points"]
    transcript = payload.transcript

    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript is required for /analyze/content.")

    if not expected_text and not key_points:
        raise HTTPException(
            status_code=400,
            detail="Provide either expected_text or key_points for content analysis.",
        )

    result = safe_content_analysis(
        transcript=transcript,
        expected_text=expected_text,
        key_points=key_points,
    )

    session["latest_transcript"] = transcript
    session["content_history"].append({
        **result,
        "timestamp": time.time(),
    })

    return result


@app.post("/transcribe-and-analyze-content")
def transcribe_and_analyze_content(payload: AudioRequest):
    session = require_session(payload.session_id)

    expected_text = session["expected_text"]
    key_points = session["key_points"]

    if not expected_text and not key_points:
        raise HTTPException(
            status_code=400,
            detail="No expected_text or key_points stored in this session.",
        )

    audio = decode_base64_audio_to_float32(payload.audio_base64)
    wav_path = write_temp_wav(audio, payload.sample_rate)

    try:
        transcript, transcription_error = safe_transcribe_audio(wav_path)

        result = safe_content_analysis(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
        )

        session["latest_transcript"] = transcript
        session["content_history"].append({
            **result,
            "timestamp": time.time(),
        })

        return {
            **result,
            "debug": {
                "transcription_error": transcription_error,
            },
        }
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)


@app.post("/session/end")
async def end_session(payload: dict[str, str]):
    session_id = payload.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required.")

    session = require_session(session_id)

    speech_summary = session["speech_stats"].summary()
    emotion_counts = Counter(session["emotion_log"])
    body_counts = Counter(session["body_feedback_log"])
    frame_checks = int(session.get("frame_checks", 0) or 0)

    top_emotion = emotion_counts.most_common(1)[0][0] if emotion_counts else "unknown"

    body_summary = {
        "overall_score": compute_body_score(body_counts, frame_checks),
        "counts": dict(body_counts),
        "top_feedback": [item[0] for item in body_counts.most_common(3)],
        "frame_checks": frame_checks,
    }

    emotion_summary = {
        "overall_score": compute_emotion_score(emotion_counts),
        "counts": dict(emotion_counts),
        "dominant_emotion": top_emotion,
    }

    latest_content = session["content_history"][-1] if session["content_history"] else None
    full_transcript = " ".join(
        chunk.strip()
        for chunk in session.get("chunk_transcripts", [])
        if isinstance(chunk, str) and chunk.strip()
    ).strip() or session.get("latest_transcript", "")
    content_summary = build_content_summary(
        content_history=session.get("content_history", []),
        full_transcript=full_transcript,
        expected_text=session.get("expected_text", ""),
        key_points=session.get("key_points", []),
    )

    speech_summary["overall_score"] = compute_speech_score(speech_summary)
    speech_summary["overall_assessment"] = (
        "Limited delivery data was captured, so this score is a neutral estimate."
        if int(speech_summary.get("windows", 0) or 0) <= 0
        else "Strong delivery overall."
        if speech_summary["overall_score"] >= 80
        else "Solid progress with a few delivery areas to improve."
        if speech_summary["overall_score"] >= 65
        else "Your delivery needs more consistency, but the practice data is useful."
    )

    category_scores = [
        speech_summary.get("overall_score", 0),
        body_summary.get("overall_score", 0),
        emotion_summary.get("overall_score", 0),
        content_summary.get("overall_score", 0) if content_summary else 0,
    ]
    valid_scores = [score for score in category_scores if score > 0]
    overall_score = clamp_score(sum(valid_scores) / len(valid_scores)) if valid_scores else 0

    overall_feedback: list[str] = []
    overall_feedback.extend(speech_summary.get("what_went_well", []))
    overall_feedback.extend(speech_summary.get("areas_to_improve", []))

    if body_summary["top_feedback"]:
        overall_feedback.append(f"Body language to watch: {body_summary['top_feedback'][0]}")

    if content_summary:
        if content_summary.get("topic_status") == "topic_drift":
            overall_feedback.append("Try staying more closely aligned with your planned message.")
        elif content_summary.get("ai_content_tip"):
            overall_feedback.append(content_summary["ai_content_tip"])

    response = {
        "session_id": session_id,
        "attempt_id": session_id,
        "session_group_id": session.get("session_group_id"),
        "created_at": session.get("created_at"),
        "updated_at": time.time(),
        "status": "completed",
        "username": session.get("username", ""),
        "title": session.get("title"),
        "expected_text": session.get("expected_text", ""),
        "key_points": session.get("key_points", []),
        "overall_score": overall_score,
        "speech_summary": speech_summary,
        "emotion_summary": emotion_summary,
        "body_summary": body_summary,
        "content_summary": content_summary,
        "session_grade": build_session_grade(
            overall_score,
            speech_summary.get("overall_score", 0),
            content_summary.get("overall_score", 0) if content_summary else 0,
            body_summary.get("overall_score", 0),
            emotion_summary.get("overall_score", 0),
        ),
        "latest_transcript": session.get("latest_transcript", ""),
        "transcript": full_transcript,
        "content_history": session.get("content_history", []),
        "overall_feedback": overall_feedback,
    }

    await sessions_collection.update_one(
        {"session_id": session_id},
        {"$set": response},
        upsert=True,
    )

    del SESSIONS[session_id]
    return response


@app.post("/auth/signup")
async def signup(payload: SignupRequest):
    username = payload.username.strip().lower()
    name = payload.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")

    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="Username and password are required.")

    existing = await users_collection.find_one({"username": username})
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists.")

    await users_collection.insert_one({
        "name": name,
        "username": username,
        "password": payload.password,
        "created_at": time.time(),
    })

    return {"status": "ok", "username": username}


@app.post("/auth/login")
async def login(payload: LoginRequest):
    username = payload.username.strip().lower()

    user = await users_collection.find_one({"username": username})
    if not user or user.get("password") != payload.password:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    return {"status": "ok", "username": username}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str, username: str):
    normalized_username = username.strip().lower()

    result = await sessions_collection.delete_many({
        "$or": [
            {"session_id": session_id, "username": normalized_username},
            {"session_group_id": session_id, "username": normalized_username},
        ]
    })

    if result.deleted_count == 0:
        matching_attempt_ids: list[str] = []
        cursor = sessions_collection.find(
            {"status": "completed", "username": normalized_username},
            {
                "_id": 0,
                "session_id": 1,
                "session_group_id": 1,
                "title": 1,
                "expected_text": 1,
                "key_points": 1,
            },
        )
        async for item in cursor:
            if get_group_id_for_record(item) == session_id:
                matching_attempt_ids.append(str(item.get("session_id")))

        if matching_attempt_ids:
            result = await sessions_collection.delete_many({
                "session_id": {"$in": matching_attempt_ids},
                "username": normalized_username,
            })

    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Session not found.")

    return {"status": "ok", "deleted_session_id": session_id}
