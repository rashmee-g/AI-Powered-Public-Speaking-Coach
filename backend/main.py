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


app = FastAPI(title="AI Public Speaking Coach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSIONS: dict[str, dict[str, Any]] = {}


# -----------------------------
# Request models
# -----------------------------
class StartSessionRequest(BaseModel):
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

    SESSIONS[session_id] = {
        "created_at": time.time(),
        "expected_text": payload.expected_text,
        "key_points": payload.key_points,
        "speech_stats": SessionStats(),
        "emotion_log": [],
        "pose_state": default_pose_state(),
        "body_feedback_log": [],
        "latest_transcript": "",
        "chunk_transcripts": [],
        "content_history": [],
    }

    return {
        "session_id": session_id,
        "status": "started",
    }


@app.post("/analyze/frame")
def analyze_frame(payload: FrameRequest):
    session = require_session(payload.session_id)
    frame = decode_base64_image(payload.image_base64)
    frame = cv2.flip(frame, 1)

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
        ) if transcript and expected_text else {
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

        if transcript:
            session["latest_transcript"] = transcript
            session["chunk_transcripts"].append(transcript)

        if result is None:
            session["content_history"].append({
                "transcript": transcript,
                "ai_content_tip": content_result.get("ai_content_tip", ""),
                "topic_status": content_result.get("topic_status", "no_content"),
                "similarity_score": content_result.get("similarity_score", 0.0),
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

        session["content_history"].append({
            "transcript": transcript,
            "ai_content_tip": ai_feedback.get("content_tip", ""),
            "positive_note": ai_feedback.get("positive_note", ""),
            "live_tip": ai_feedback.get("live_tip", ""),
            "topic_status": content_result.get("topic_status", "not_checked"),
            "similarity_score": content_result.get("similarity_score", 0.0),
            "missed_points": content_result.get("missed_points", []),
            "timestamp": time.time(),
        })

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
def analyze_content_route(payload: ContentRequest):
    session = require_session(payload.session_id)

    expected_text = payload.expected_text or session["expected_text"]
    key_points = payload.key_points or session["key_points"]
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
def end_session(payload: dict[str, str]):
    session_id = payload.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required.")

    session = require_session(session_id)

    speech_summary = session["speech_stats"].summary()
    emotion_counts = Counter(session["emotion_log"])
    body_counts = Counter(session["body_feedback_log"])

    top_emotion = emotion_counts.most_common(1)[0][0] if emotion_counts else "unknown"

    body_summary = {
        "counts": dict(body_counts),
        "top_feedback": [item[0] for item in body_counts.most_common(3)],
    }

    emotion_summary = {
        "counts": dict(emotion_counts),
        "dominant_emotion": top_emotion,
    }

    latest_content = session["content_history"][-1] if session["content_history"] else None

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

    response = {
        "speech_summary": speech_summary,
        "emotion_summary": emotion_summary,
        "body_summary": body_summary,
        "content_summary": latest_content,
        "latest_transcript": session.get("latest_transcript", ""),
        "overall_feedback": overall_feedback,
    }

    del SESSIONS[session_id]
    return response