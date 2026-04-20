from __future__ import annotations

import base64
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

# Keep live rolling speech stats in memory during active sessions.
# MongoDB stores persistent session/report data.
LIVE_SPEECH_STATS: dict[str, dict[str, Any]] = {}
LIVE_POSE_STATES: dict[str, dict[str, Any]] = {}


# -----------------------------
# Request models
# -----------------------------
class StartSessionRequest(BaseModel):
    username: str
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


async def require_session(session_id: str) -> dict[str, Any]:
    session = await sessions_collection.find_one({"session_id": session_id})
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
) -> str:
    if speech_headline and speech_headline.strip() and speech_headline != "Good delivery overall.":
        return speech_headline

    if body_feedback:
        return body_feedback[0]

    if emotion not in ("...", "", "neutral", "unknown"):
        return f"Facial emotion detected: {emotion}"

    return "Good job — keep going."


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

def clamp_score(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def score_speech(speech_summary: dict[str, Any]) -> tuple[float, dict[str, float]]:
    score = 40.0
    issues = speech_summary.get("issue_counts", {})
    medians = speech_summary.get("medians", {})

    # Penalize repeated issue windows
    score -= 4.0 * issues.get("pace_alert", 0)
    score -= 2.0 * issues.get("pace_watch", 0)

    score -= 4.0 * issues.get("volume_alert", 0)
    score -= 2.0 * issues.get("volume_watch", 0)

    score -= 4.0 * issues.get("pauses_alert", 0)
    score -= 2.0 * issues.get("pauses_watch", 0)

    score -= 4.0 * issues.get("pitch_alert", 0)
    score -= 2.0 * issues.get("pitch_watch", 0)

    # Small reward for healthy medians
    wpm = medians.get("estimated_wpm", 0.0)
    if 115 <= wpm <= 175:
        score += 2.0

    pitch_range = medians.get("pitch_range_hz", 0.0)
    if pitch_range >= 35:
        score += 2.0

    score = clamp_score(score, 0.0, 40.0)

    return score, {
        "wpm": float(wpm),
        "pitch_range_hz": float(pitch_range),
        "silence_pct": float(medians.get("silence_pct", 0.0)),
    }


def score_content(latest_content: dict[str, Any] | None) -> float:
    if not latest_content:
        return 10.0

    similarity = float(latest_content.get("similarity_score", 0.0))
    missed_points = latest_content.get("missed_points", []) or []
    topic_status = latest_content.get("topic_status", "no_content")

    score = similarity * 30.0

    # Penalty for missed key points
    score -= min(len(missed_points) * 2.0, 8.0)

    if topic_status == "topic_drift":
        score -= 6.0
    elif topic_status == "no_content":
        score = min(score, 8.0)
    elif topic_status == "not_checked":
        score = min(score, 15.0)

    return clamp_score(score, 0.0, 30.0)


def score_body(body_summary: dict[str, Any]) -> float:
    score = 20.0
    counts = body_summary.get("counts", {}) or {}

    score -= 3.0 * counts.get("Hand fidgeting detected", 0)
    score -= 3.0 * counts.get("Looking around", 0)
    score -= 3.0 * counts.get("Slouching posture", 0)
    score -= 3.0 * counts.get("Excessive body sway", 0)

    return clamp_score(score, 0.0, 20.0)


def score_emotion(emotion_summary: dict[str, Any]) -> float:
    dominant = emotion_summary.get("dominant_emotion", "unknown")

    if dominant in ("happy", "neutral", "confident"):
        return 10.0
    if dominant in ("surprise",):
        return 8.0
    if dominant in ("fear", "sad", "angry", "disgust"):
        return 5.0
    return 7.0


def letter_grade(score: float) -> str:
    if score >= 97:
        return "A+"
    if score >= 93:
        return "A"
    if score >= 90:
        return "A-"
    if score >= 87:
        return "B+"
    if score >= 83:
        return "B"
    if score >= 80:
        return "B-"
    if score >= 77:
        return "C+"
    if score >= 73:
        return "C"
    if score >= 70:
        return "C-"
    if score >= 67:
        return "D+"
    if score >= 63:
        return "D"
    if score >= 60:
        return "D-"
    return "F"


def grade_session(
    speech_summary: dict[str, Any],
    body_summary: dict[str, Any],
    emotion_summary: dict[str, Any],
    latest_content: dict[str, Any] | None,
) -> dict[str, Any]:
    speech_score, speech_details = score_speech(speech_summary)
    content_score = score_content(latest_content)
    body_score = score_body(body_summary)
    emotion_score = score_emotion(emotion_summary)

    total_score = round(speech_score + content_score + body_score + emotion_score, 1)
    grade = letter_grade(total_score)

    if total_score >= 90:
        summary = "Excellent session overall with strong delivery and content control."
    elif total_score >= 80:
        summary = "Strong session overall with a few improvement areas."
    elif total_score >= 70:
        summary = "Solid progress, but there are still noticeable areas to improve."
    elif total_score >= 60:
        summary = "This was a useful practice session, but several speaking areas need work."
    else:
        summary = "Early practice stage — keep building consistency in delivery and content."

    return {
        "score": total_score,
        "letter": grade,
        "breakdown": {
            "speech": round(speech_score, 1),
            "content": round(content_score, 1),
            "body": round(body_score, 1),
            "emotion": round(emotion_score, 1),
        },
        "details": speech_details,
        "summary": summary,
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
async def status():
    active_sessions = await sessions_collection.count_documents({"status": "active"})
    return {
        "status": "ok",
        "active_sessions": active_sessions,
    }


@app.get("/sessions")
async def list_completed_sessions(username: str):
    username = username.strip().lower()

    sessions = []
    cursor = sessions_collection.find(
        {"status": "completed", "username": username},
        {
            "_id": 0,
            "session_id": 1,
            "username": 1,
            "created_at": 1,
            "expected_text": 1,
            "key_points": 1,
            "overall_feedback": 1,
            "speech_summary": 1,
            "emotion_summary": 1,
            "body_summary": 1,
            "content_summary": 1,
            "session_grade": 1,
        },
    ).sort("created_at", -1)

    async for doc in cursor:
        sessions.append(doc)

    return sessions


@app.get("/sessions/{session_id}")
async def get_session_report(session_id: str, username: str):
    username = username.strip().lower()

    session = await sessions_collection.find_one(
        {"session_id": session_id, "username": username},
        {"_id": 0},
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


@app.post("/session/start")
async def start_session(payload: StartSessionRequest):
    session_id = str(uuid.uuid4())
    now = time.time()

    session_doc = {
        "session_id": session_id,
        "username": payload.username.strip().lower(),
        "created_at": now,
        "updated_at": now,
        "status": "active",
        "expected_text": payload.expected_text,
        "key_points": payload.key_points,
        "emotion_log": [],
        "pose_state": default_pose_state(),
        "body_feedback_log": [],
        "latest_transcript": "",
        "chunk_transcripts": [],
        "content_history": [],
    }

    await sessions_collection.insert_one(session_doc)
    LIVE_SPEECH_STATS[session_id] = SessionStats()
    LIVE_POSE_STATES[session_id] = default_pose_state()

    return {
        "session_id": session_id,
        "status": "started",
    }


@app.post("/analyze/frame")
async def analyze_frame(payload: FrameRequest):
    session = await require_session(payload.session_id)
    frame = decode_base64_image(payload.image_base64)
    frame = cv2.flip(frame, 1)

    try:
        emotion_raw = analyze_emotion_frame(frame)
    except Exception as e:
        print("Emotion analysis error:", e)
        emotion_raw = "unknown"

    pose_state = LIVE_POSE_STATES.setdefault(payload.session_id, default_pose_state())

    try:
        body_feedback = analyze_pose_frame(frame, pose_state)
    except Exception as e:
        print("Pose analysis error:", e)
        body_feedback = []

    update_ops: dict[str, Any] = {
        "$set": {
            "updated_at": time.time(),
        }
    }

    if emotion_raw and emotion_raw not in ("...", "", "unknown"):
        update_ops.setdefault("$push", {})["emotion_log"] = emotion_raw

    if body_feedback:
        update_ops.setdefault("$push", {})["body_feedback_log"] = {
            "$each": body_feedback
        }

    await sessions_collection.update_one({"session_id": payload.session_id}, update_ops)

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
async def analyze_audio(payload: AudioRequest):
    await require_session(payload.session_id)
    audio = decode_base64_audio_to_float32(payload.audio_base64)

    result = analyze(audio)

    if result is None:
        return {
            "status": {
                "overall": "Listening",
                "headline": "Keep speaking so I can analyze your delivery.",
            },
            "messages": [],
            "metrics": {
                "wpm": 0,
                "avg_dbfs": -80,
                "snr_db": 0,
                "pitch_range_hz": 0,
                "silence_pct": 0,
            },
            "live_tip": "Keep speaking so I can analyze your delivery.",
        }

    stats = LIVE_SPEECH_STATS.setdefault(payload.session_id, SessionStats())
    stats.add(result)

    await sessions_collection.update_one(
        {"session_id": payload.session_id},
        {"$set": {"updated_at": time.time()}},
    )

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
    session = await require_session(session_id)

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
            if result is not None and "wpm" not in result.get("metrics", {}):
                result = None
        except Exception as e:
            print("Speech analyze() error:", e)
            result = None

        expected_text = session.get("expected_text", "")
        key_points = session.get("key_points", [])

        content_result = (
            safe_content_analysis(
                transcript=transcript,
                expected_text=expected_text,
                key_points=key_points,
            )
            if transcript and expected_text
            else {
                "transcript": transcript,
                "similarity_score": 0.0,
                "missed_points": [],
                "topic_status": "not_checked" if transcript else "no_content",
                "ai_content_tip": (
                    "Transcript captured, but no expected speech was provided."
                    if transcript and not expected_text
                    else "Not enough spoken content yet."
                ),
            }
        )

        update_ops: dict[str, Any] = {
            "$set": {
                "updated_at": time.time(),
            }
        }

        if transcript:
            update_ops["$set"]["latest_transcript"] = transcript
            update_ops.setdefault("$push", {})["chunk_transcripts"] = transcript

        if result is None:
            content_entry = {
                "transcript": transcript,
                "ai_content_tip": content_result.get("ai_content_tip", ""),
                "topic_status": content_result.get("topic_status", "no_content"),
                "similarity_score": content_result.get("similarity_score", 0.0),
                "missed_points": content_result.get("missed_points", []),
                "timestamp": time.time(),
            }
            update_ops.setdefault("$push", {})["content_history"] = content_entry
            await sessions_collection.update_one({"session_id": session_id}, update_ops)

            return {
                "status": {
                    "overall": "Listening",
                    "headline": "Keep speaking so I can analyze your delivery.",
                },
                "messages": [],
                "metrics": {
                    "wpm": 0,
                    "avg_dbfs": -80,
                    "snr_db": 0,
                    "pitch_range_hz": 0,
                    "silence_pct": 0,
                    "duration_s": round(duration_s, 2),
                    "max_amp": round(max_amp, 4),
                },
                "live_tip": "Keep speaking so I can analyze your delivery.",
                "ai_content_tip": content_result.get("ai_content_tip", "Not enough spoken content yet."),
                "positive_note": "",
                "transcript": transcript,
                "similarity_score": content_result.get("similarity_score", 0.0),
                "missed_points": content_result.get("missed_points", []),
                "topic_status": content_result.get("topic_status", "no_content"),
                "debug": {
                    "reason": "analyze_returned_none_or_failed",
                    "audio_duration_s": round(duration_s, 2),
                    "audio_samples": int(audio.size),
                    "transcription_error": transcription_error,
                },
            }

        stats = LIVE_SPEECH_STATS.setdefault(session_id, SessionStats())
        stats.add(result)

        ai_feedback = safe_ai_feedback(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
            metrics=result["metrics"],
            fallback_live_tip=result["status"]["headline"],
        )

        if not ai_feedback.get("content_tip") and content_result.get("ai_content_tip"):
            ai_feedback["content_tip"] = content_result["ai_content_tip"]

        content_entry = {
            "transcript": transcript,
            "ai_content_tip": ai_feedback.get("content_tip", ""),
            "positive_note": ai_feedback.get("positive_note", ""),
            "live_tip": ai_feedback.get("live_tip", ""),
            "topic_status": content_result.get("topic_status", "not_checked"),
            "similarity_score": content_result.get("similarity_score", 0.0),
            "missed_points": content_result.get("missed_points", []),
            "timestamp": time.time(),
        }

        update_ops.setdefault("$push", {})["content_history"] = content_entry
        await sessions_collection.update_one({"session_id": session_id}, update_ops)

        return {
            "status": result["status"],
            "messages": result["messages"],
            "metrics": result["metrics"],
            "raw_alerts": result.get("raw_alerts", []),
            "live_tip": ai_feedback.get("live_tip", result["status"]["headline"]),
            "ai_content_tip": ai_feedback.get("content_tip", ""),
            "positive_note": ai_feedback.get("positive_note", ""),
            "transcript": transcript,
            "similarity_score": content_result.get("similarity_score", 0.0),
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
async def analyze_content_route(payload: ContentRequest):
    session = await require_session(payload.session_id)

    expected_text = payload.expected_text or session.get("expected_text", "")
    key_points = payload.key_points or session.get("key_points", [])
    transcript = payload.transcript

    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript is required for /analyze/content.")

    if not expected_text:
        raise HTTPException(
            status_code=400,
            detail="expected_text is missing. Provide it when starting the session or in this request.",
        )

    result = safe_content_analysis(
        transcript=transcript,
        expected_text=expected_text,
        key_points=key_points,
    )

    await sessions_collection.update_one(
        {"session_id": payload.session_id},
        {
            "$set": {
                "latest_transcript": transcript,
                "updated_at": time.time(),
            },
            "$push": {
                "content_history": {
                    **result,
                    "timestamp": time.time(),
                }
            },
        },
    )

    return result


@app.post("/transcribe-and-analyze-content")
async def transcribe_and_analyze_content(payload: AudioRequest):
    session = await require_session(payload.session_id)

    expected_text = session.get("expected_text", "")
    key_points = session.get("key_points", [])

    if not expected_text:
        raise HTTPException(status_code=400, detail="No expected_text stored in this session.")

    audio = decode_base64_audio_to_float32(payload.audio_base64)
    wav_path = write_temp_wav(audio, payload.sample_rate)

    try:
        transcript, transcription_error = safe_transcribe_audio(wav_path)

        result = safe_content_analysis(
            transcript=transcript,
            expected_text=expected_text,
            key_points=key_points,
        )

        await sessions_collection.update_one(
            {"session_id": payload.session_id},
            {
                "$set": {
                    "latest_transcript": transcript,
                    "updated_at": time.time(),
                },
                "$push": {
                    "content_history": {
                        **result,
                        "timestamp": time.time(),
                    }
                },
            },
        )

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

    session = await require_session(session_id)

    stats = LIVE_SPEECH_STATS.get(session_id, SessionStats())
    speech_summary = stats.summary()

    emotion_counts = Counter(session.get("emotion_log", []))
    body_counts = Counter(session.get("body_feedback_log", []))

    top_emotion = emotion_counts.most_common(1)[0][0] if emotion_counts else "unknown"

    body_summary = {
        "counts": dict(body_counts),
        "top_feedback": [item[0] for item in body_counts.most_common(3)],
    }

    emotion_summary = {
        "counts": dict(emotion_counts),
        "dominant_emotion": top_emotion,
    }

    content_history = session.get("content_history", [])
    latest_content = content_history[-1] if content_history else None

    overall_feedback: list[str] = []
    overall_feedback.extend(speech_summary.get("what_went_well", []))
    overall_feedback.extend(speech_summary.get("areas_to_improve", []))

    if body_summary["top_feedback"]:
        overall_feedback.append(f"Body language to watch: {body_summary['top_feedback'][0]}")

    if latest_content:
        if latest_content.get("topic_status") == "topic_drift":
            overall_feedback.append("Try staying more closely aligned with your planned message.")
        elif latest_content.get("ai_content_tip"):
            overall_feedback.append(latest_content["ai_content_tip"])
    
    session_grade = grade_session(
    speech_summary=speech_summary,
    body_summary=body_summary,
    emotion_summary=emotion_summary,
    latest_content=latest_content,
    )

    response = {
        "session_id": session_id,
        "speech_summary": speech_summary,
        "emotion_summary": emotion_summary,
        "body_summary": body_summary,
        "content_summary": latest_content,
        "latest_transcript": session.get("latest_transcript", ""),
        "overall_feedback": overall_feedback,
        "session_grade": session_grade,
    }

    await sessions_collection.update_one(
        {"session_id": session_id},
        {
            "$set": {
                "status": "completed",
                "updated_at": time.time(),
                "speech_summary": speech_summary,
                "emotion_summary": emotion_summary,
                "body_summary": body_summary,
                "content_summary": latest_content,
                "overall_feedback": overall_feedback,
                "session_grade": session_grade,
            }
        },
    )

    LIVE_SPEECH_STATS.pop(session_id, None)
    LIVE_POSE_STATES.pop(session_id, None)
    return response

@app.post("/auth/signup")
async def signup(payload: SignupRequest):
    username = payload.username.strip().lower()

    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="Username and password are required.")
    
    existing = await users_collection.find_one({"username": username})
    if existing: 
        raise HTTPException(status_code=400, detail="Username already exists.")
    
    await users_collection.insert_one({
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
    username = username.strip().lower()

    result = await sessions_collection.delete_one({
        "session_id": session_id,
        "username": username,
    })

    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Session not found.")

    return {"status": "ok", "deleted_session_id": session_id}