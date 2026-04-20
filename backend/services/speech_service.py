from __future__ import annotations

import json
import queue
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import sounddevice as sd


# ============================================================
# Config
# ============================================================

SR = 16000
CHUNK_MS = 30
CHUNK = int(SR * CHUNK_MS / 1000)

ANALYSIS_SEC = 4.0          # rolling window length
UPDATE_SEC = 0.75           # how often to emit a reading
MIN_ANALYZE_SEC = 0.8       # minimum audio length before analyze()

# Baseline calibration
NOISE_CALIBRATION_SEC = 1.5
USER_CALIBRATION_SEC = 8.0

# Pace defaults / fallback
DEFAULT_FAST_WPM = 185
DEFAULT_SLOW_WPM = 110

# Volume defaults / fallback
DEFAULT_HIGH_VOL_DBFS = -15.0
MIN_SNR_DB = 12.0

# Pauses
LONG_PAUSE_S = 1.5
MIN_SILENCE_S = 0.25
TOP_DB = 28.0

# Pitch / monotone defaults
DEFAULT_MONOTONE_HZ = 25.0
MIN_VOICED = 0.4

# Smoothing / persistence
PACE_HISTORY_LEN = 5
VOLUME_HISTORY_LEN = 5
PITCH_HISTORY_LEN = 5
SILENCE_HISTORY_LEN = 5
ISSUE_PERSISTENCE_WINDOWS = 3
MESSAGE_COOLDOWN_SEC = 3.0

# Output
SHOW_RAW_METRICS = True
SAVE_SUMMARY_JSON: str | None = None


# ============================================================
# Runtime state
# ============================================================

buffer: deque[float] = deque(maxlen=int(SR * ANALYSIS_SEC))
audio_q: "queue.Queue[np.ndarray]" = queue.Queue()

noise_floor_dbfs: float = -60.0

user_baseline: dict[str, float] = {
    "baseline_dbfs": -24.0,
    "baseline_wpm": 145.0,
    "baseline_pitch": 40.0,
    "baseline_silence_pct": 18.0,
}

pace_history: deque[float] = deque(maxlen=PACE_HISTORY_LEN)
volume_history: deque[float] = deque(maxlen=VOLUME_HISTORY_LEN)
pitch_history: deque[float] = deque(maxlen=PITCH_HISTORY_LEN)
silence_history: deque[float] = deque(maxlen=SILENCE_HISTORY_LEN)

issue_history: deque[list[str]] = deque(maxlen=ISSUE_PERSISTENCE_WINDOWS)


# ============================================================
# Audio callback
# ============================================================

def audio_callback(indata, frames, time_info, status):
    audio_q.put(indata[:, 0].copy())


# ============================================================
# Calibration
# ============================================================

def calibrate_noise(duration_s: float = NOISE_CALIBRATION_SEC) -> float:
    print(f"Calibrating room noise — stay quiet for {duration_s:.1f}s...")
    samples: list[np.ndarray] = []
    deadline = time.time() + duration_s

    with sd.InputStream(
        samplerate=SR,
        channels=1,
        dtype="float32",
        blocksize=CHUNK,
        callback=audio_callback,
    ):
        while time.time() < deadline:
            try:
                samples.append(audio_q.get(timeout=0.5))
            except queue.Empty:
                pass

    while not audio_q.empty():
        try:
            audio_q.get_nowait()
        except queue.Empty:
            break

    if not samples:
        print("Noise calibration failed; using fallback noise floor -60 dBFS.\n")
        return -60.0

    y = np.concatenate(samples)
    rms = float(np.sqrt(np.mean(y ** 2) + 1e-12))
    db = float(20 * np.log10(rms + 1e-12))
    print(f"Noise floor: {db:.1f} dBFS\n")
    return db


def calibrate_user(duration_s: float = USER_CALIBRATION_SEC) -> dict[str, float]:
    print(f"Calibration speech sample — speak normally for {duration_s:.1f}s...")

    samples: list[np.ndarray] = []
    deadline = time.time() + duration_s

    with sd.InputStream(
        samplerate=SR,
        channels=1,
        dtype="float32",
        blocksize=CHUNK,
        callback=audio_callback,
    ):
        while time.time() < deadline:
            try:
                samples.append(audio_q.get(timeout=0.5))
            except queue.Empty:
                pass

    while not audio_q.empty():
        try:
            audio_q.get_nowait()
        except queue.Empty:
            break

    if not samples:
        print("User calibration failed; using fallback speaking baseline.\n")
        return user_baseline.copy()

    y = np.concatenate(samples).astype(np.float32)
    y = y - float(np.mean(y))

    y_sp, speaking_time = speech_only(y)
    avg_dbfs = measure_volume(y_sp)
    wpm = measure_pace(y_sp, speaking_time)
    long_pauses, silence_ratio = measure_pauses(y)

    try:
        pitch_range, voiced_ratio = measure_pitch_range(y_sp)
    except Exception:
        pitch_range, voiced_ratio = 0.0, 0.0

    baseline = {
        "baseline_dbfs": avg_dbfs if np.isfinite(avg_dbfs) else -24.0,
        "baseline_wpm": wpm if wpm > 0 else 145.0,
        "baseline_pitch": pitch_range if pitch_range > 0 else 40.0,
        "baseline_silence_pct": silence_ratio * 100.0,
    }

    print("User baseline:")
    print(json.dumps({k: round(v, 2) for k, v in baseline.items()}, indent=2))
    print()

    return baseline


# ============================================================
# Feature extraction
# ============================================================

def is_actively_speaking(
    audio: np.ndarray,
    avg_dbfs: float,
    voiced_ratio: float,
    speaking_time_s: float,
) -> bool:
    # Too quiet overall
    if avg_dbfs < -50:
        return False

    # Not enough voiced content
    if voiced_ratio < 0.25:
        return False

    # Too little actual speech in the chunk
    if speaking_time_s < 0.6:
        return False

    # Tiny/noisy chunks
    if audio.size < 16000 * 0.5:  # less than 0.5 sec at 16kHz
        return False

    return True

def measure_pace(y_speech: np.ndarray, speaking_time_s: float) -> float:
    if speaking_time_s < 0.4 or y_speech.size < SR * 0.2:
        return 0.0

    hop = 256
    onset_env = librosa.onset.onset_strength(
        y=y_speech,
        sr=SR,
        hop_length=hop,
        aggregate=np.median,
        fmax=3500,
    )

    onsets = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=SR,
        hop_length=hop,
        backtrack=True,
        units="time",
        delta=0.12,
        wait=max(1, int(SR * 0.08 / hop)),
    )

    # rough syllables -> words conversion
    syllables_per_min = float(len(onsets) / max(speaking_time_s, 1e-6) * 60.0)
    estimated_wpm = syllables_per_min / 1.5
    return float(estimated_wpm)


def measure_volume(y_speech: np.ndarray) -> float:
    if y_speech.size == 0:
        return -80.0
    rms = float(np.sqrt(np.mean(y_speech ** 2) + 1e-12))
    return float(20 * np.log10(rms + 1e-12))


def measure_pauses(y: np.ndarray) -> tuple[int, float]:
    duration = len(y) / SR
    if duration <= 0:
        return 0, 0.0

    intervals = librosa.effects.split(y, top_db=TOP_DB)
    speech_segs = [(s / SR, e / SR) for s, e in intervals]

    silence_gaps: list[float] = []
    prev = 0.0

    for s, e in speech_segs:
        if s - prev >= MIN_SILENCE_S:
            silence_gaps.append(s - prev)
        prev = e

    if prev < duration and (duration - prev) >= MIN_SILENCE_S:
        silence_gaps.append(duration - prev)

    gaps = np.array(silence_gaps, dtype=np.float32)
    long_pauses = int(np.sum(gaps >= LONG_PAUSE_S)) if gaps.size else 0
    silence_ratio = float(gaps.sum() / max(duration, 1e-6)) if gaps.size else 0.0
    return long_pauses, silence_ratio


def measure_pitch_range(y_speech: np.ndarray) -> tuple[float, float]:
    if y_speech.size < SR * 0.25:
        return 0.0, 0.0

    f0, voiced, _ = librosa.pyin(
        y_speech,
        fmin=80,
        fmax=450,
        sr=SR,
        frame_length=2048,
        hop_length=512,
    )

    if f0 is None or voiced is None or not voiced.any():
        return 0.0, 0.0

    voiced_ratio = float(np.mean(voiced))
    f0v = f0[voiced].astype(np.float32)

    if f0v.size > 2:
        med = np.median(f0v)
        f0v = f0v[(f0v > med * 0.5) & (f0v < med * 2.0)]

    if f0v.size < 5:
        return 0.0, voiced_ratio

    pitch_range = float(np.percentile(f0v, 90) - np.percentile(f0v, 10))
    return pitch_range, voiced_ratio


def speech_only(y: np.ndarray) -> tuple[np.ndarray, float]:
    intervals = librosa.effects.split(y, top_db=TOP_DB)
    parts = [y[s:e] for s, e in intervals if (e - s) > int(SR * 0.05)]

    if not parts:
        return np.array([], dtype=np.float32), 0.0

    audio = np.concatenate(parts)
    speaking_time = sum((e - s) / SR for s, e in intervals)
    return audio, speaking_time


# ============================================================
# Helpers
# ============================================================

def sev_rank(severity: str) -> int:
    return {"ok": 0, "watch": 1, "alert": 2}.get(severity, 0)


def severity_prefix(severity: str) -> str:
    return {
        "ok": "[OK]",
        "watch": "[WARNING]",
        "alert": "[ALERT]",
    }.get(severity, "[INFO]")


def _median_or_default(values: deque[float], default: float) -> float:
    if not values:
        return default
    return float(np.median(np.array(values, dtype=np.float32)))


def get_dynamic_thresholds() -> dict[str, float]:
    baseline_wpm = user_baseline.get("baseline_wpm", 145.0)
    baseline_dbfs = user_baseline.get("baseline_dbfs", -24.0)
    baseline_pitch = user_baseline.get("baseline_pitch", 40.0)
    baseline_silence = user_baseline.get("baseline_silence_pct", 18.0)

    fast_wpm = max(DEFAULT_FAST_WPM, baseline_wpm + 25.0)
    slow_wpm = min(DEFAULT_SLOW_WPM, max(90.0, baseline_wpm - 35.0))

    loud_dbfs = max(DEFAULT_HIGH_VOL_DBFS, baseline_dbfs + 10.0)
    quiet_dbfs = baseline_dbfs - 8.0

    monotone_hz = min(DEFAULT_MONOTONE_HZ, max(15.0, baseline_pitch * 0.6))

    pause_heavy_pct = max(40.0, baseline_silence + 18.0)
    pause_dense_pct = min(8.0, max(4.0, baseline_silence - 10.0))

    return {
        "fast_wpm": fast_wpm,
        "slow_wpm": slow_wpm,
        "loud_dbfs": loud_dbfs,
        "quiet_dbfs": quiet_dbfs,
        "monotone_hz": monotone_hz,
        "pause_heavy_pct": pause_heavy_pct,
        "pause_dense_pct": pause_dense_pct,
    }


# ============================================================
# Feedback generators
# ============================================================

def pace_feedback(wpm: float, speaking_time: float, thresholds: dict[str, float]) -> dict[str, str]:
    if speaking_time < 1.2 or wpm <= 0:
        return {
            "label": "Waiting for more speech",
            "severity": "ok",
            "message": "Keep speaking so I can judge your pace.",
            "short": "Listening for pace",
        }

    if wpm > thresholds["fast_wpm"]:
        return {
            "label": "Fast",
            "severity": "alert",
            "message": "Slow down a little so each phrase lands more clearly.",
            "short": "Slow down a little",
        }

    if wpm < thresholds["slow_wpm"]:
        return {
            "label": "Slow",
            "severity": "watch",
            "message": "Pick up the pace slightly to keep the energy moving.",
            "short": "Pick up the pace slightly",
        }

    return {
        "label": "Good",
        "severity": "ok",
        "message": "Your pace is in a good range.",
        "short": "Pace is in a good range",
    }


def volume_feedback(
    avg_dbfs: float,
    snr_db: float,
    thresholds: dict[str, float],
) -> dict[str, str]:
    if avg_dbfs > thresholds["loud_dbfs"]:
        return {
            "label": "Too loud",
            "severity": "watch",
            "message": "Back off the volume a bit so you sound controlled, not forced.",
            "short": "Back off the volume a bit",
        }

    if snr_db < MIN_SNR_DB - 4:
        return {
            "label": "Hard to hear",
            "severity": "alert",
            "message": "Speak clearly louder so your voice stands out from the room noise.",
            "short": "Speak louder",
        }

    if avg_dbfs < thresholds["quiet_dbfs"] or snr_db < MIN_SNR_DB:
        return {
            "label": "Slightly quiet",
            "severity": "watch",
            "message": "Speak a bit louder and more forward.",
            "short": "Speak a bit louder",
        }

    return {
        "label": "Good",
        "severity": "ok",
        "message": "Your volume is in a healthy range.",
        "short": "Volume is in a healthy range",
    }


def pause_feedback(long_pauses: int, silence_pct: float, thresholds: dict[str, float]) -> dict[str, str]:
    if long_pauses >= 2:
        return {
            "label": "Long pauses",
            "severity": "alert",
            "message": "Your pauses are running a bit long. Try keeping your thought flow moving.",
            "short": "Keep pauses shorter",
        }

    if long_pauses == 1:
        return {
            "label": "One long pause",
            "severity": "watch",
            "message": "You had a long pause. Try a slightly quicker restart after the pause.",
            "short": "Quicker restart after pauses",
        }

    if silence_pct >= thresholds["pause_heavy_pct"]:
        return {
            "label": "Pause-heavy",
            "severity": "watch",
            "message": "There is quite a bit of silence. Try linking ideas more smoothly.",
            "short": "Link ideas more smoothly",
        }

    if silence_pct <= thresholds["pause_dense_pct"]:
        return {
            "label": "Very dense",
            "severity": "watch",
            "message": "You are packing words in tightly. A little more breathing room could help.",
            "short": "Add a bit more breathing room",
        }

    return {
        "label": "Natural",
        "severity": "ok",
        "message": "Your pauses sound natural.",
        "short": "Pauses sound natural",
    }


def pitch_feedback(pitch_range: float, voiced_ratio: float, thresholds: dict[str, float]) -> dict[str, str]:
    if voiced_ratio < MIN_VOICED:
        return {
            "label": "Not enough voiced audio yet",
            "severity": "ok",
            "message": "Keep speaking so I can judge vocal variety.",
            "short": "Listening for vocal variety",
        }

    very_flat_threshold = max(10.0, thresholds["monotone_hz"] * 0.65)

    if pitch_range < very_flat_threshold:
        return {
            "label": "Very flat",
            "severity": "alert",
            "message": "Your voice sounds very flat. Emphasize key words more clearly.",
            "short": "Emphasize key words more",
        }

    if pitch_range < thresholds["monotone_hz"]:
        return {
            "label": "Flat",
            "severity": "watch",
            "message": "Add more vocal variety and emphasis to key words.",
            "short": "Add more vocal variety",
        }

    if pitch_range < thresholds["monotone_hz"] + 8:
        return {
            "label": "Slightly flat",
            "severity": "watch",
            "message": "A little more inflection would make you sound more dynamic.",
            "short": "Use a bit more inflection",
        }

    return {
        "label": "Good",
        "severity": "ok",
        "message": "Your vocal variety sounds healthy.",
        "short": "Vocal variety sounds healthy",
    }


def apply_persistence(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    current_issues = [m["area"] for m in messages if m["severity"] != "ok"]
    issue_history.append(current_issues)

    if len(issue_history) < ISSUE_PERSISTENCE_WINDOWS:
        softened = []
        for m in messages:
            if m["severity"] == "alert":
                new_m = dict(m)
                new_m["severity"] = "watch"
                softened.append(new_m)
            else:
                softened.append(m)
        return softened

    counts = Counter()
    for window in issue_history:
        counts.update(window)

    filtered: list[dict[str, str]] = []
    for m in messages:
        if m["severity"] == "ok":
            filtered.append(m)
            continue

        if counts[m["area"]] >= ISSUE_PERSISTENCE_WINDOWS:
            filtered.append(m)
        else:
            new_m = dict(m)
            if new_m["severity"] == "alert":
                new_m["severity"] = "watch"
            filtered.append(new_m)

    return filtered


def overall_feedback(
    pace_fb: dict[str, str],
    volume_fb: dict[str, str],
    pause_fb: dict[str, str],
    pitch_fb: dict[str, str],
) -> tuple[str, str, list[dict[str, str]]]:
    messages = [
        {"area": "pace", "severity": pace_fb["severity"], "text": pace_fb["message"], "short": pace_fb["short"]},
        {"area": "volume", "severity": volume_fb["severity"], "text": volume_fb["message"], "short": volume_fb["short"]},
        {"area": "pauses", "severity": pause_fb["severity"], "text": pause_fb["message"], "short": pause_fb["short"]},
        {"area": "pitch", "severity": pitch_fb["severity"], "text": pitch_fb["message"], "short": pitch_fb["short"]},
    ]

    messages = apply_persistence(messages)
    issues = [m for m in messages if m["severity"] != "ok"]

    if not issues:
        return "Good", "Your delivery sounds steady right now.", messages

    alerts = [m for m in issues if m["severity"] == "alert"]
    watches = [m for m in issues if m["severity"] == "watch"]

    if len(alerts) >= 2:
        top_two = alerts[:2]
        joined = " and ".join(m["short"].lower() for m in top_two)
        return "Needs attention", f"Focus on {joined}.", messages

    if len(alerts) == 1:
        return "Needs attention", alerts[0]["message"], messages

    if len(watches) >= 2:
        return "Mostly good", "Your delivery is mostly solid, but I’m watching a couple areas.", messages

    return "Mostly good", watches[0]["message"], messages


# ============================================================
# Main analysis
# ============================================================

def analyze(y: np.ndarray) -> dict[str, Any] | None:
    if len(y) / SR < MIN_ANALYZE_SEC:
        return None

    y = np.asarray(y, dtype=np.float32)
    y = y - float(np.mean(y))

    y_sp, speaking_time = speech_only(y)

    if speaking_time < 0.5 or y_sp.size < int(SR * 0.25):
        return None

    wpm_raw = measure_pace(y_sp, speaking_time)
    avg_dbfs_raw = measure_volume(y_sp)
    long_pauses, silence_ratio = measure_pauses(y)

    try:
        pitch_range_raw, voiced_ratio = measure_pitch_range(y_sp)
    except (SystemError, KeyboardInterrupt):
        raise
    except Exception:
        pitch_range_raw, voiced_ratio = 0.0, 0.0

    
    if not is_actively_speaking(
        audio=y,
        avg_dbfs=avg_dbfs_raw,
        voiced_ratio=voiced_ratio,
        speaking_time_s=speaking_time,
    ):
        return {
    "status": {
        "overall": "Listening",
        "headline": "Waiting for speech.",
        "pace": "Waiting for more speech",
        "volume": "Waiting for more speech",
        "pauses": "Waiting for more speech",
        "pitch": "Waiting for more speech",
    },
    "messages": [],
    "metrics": {
        "wpm": 0.0,
        "wpm_smoothed": 0.0,
        "avg_dbfs": -80.0,
        "avg_dbfs_smoothed": -80.0,
        "snr_db": 0.0,
        "snr_db_smoothed": 0.0,
        "pitch_range": 0.0,
        "pitch_range_smoothed": 0.0,
        "voiced_ratio": 0.0,
        "long_pauses": 0,
        "silence_pct": 0.0,
        "silence_pct_smoothed": 0.0,
        "speaking_time_s": 0.0,
        "noise_floor_dbfs": round(noise_floor_dbfs, 1),
    },
    "raw_alerts": [],
    "thresholds": {k: round(v, 2) for k, v in get_dynamic_thresholds().items()},
    "baseline": {k: round(v, 2) for k, v in user_baseline.items()},
}

    silence_pct_raw = silence_ratio * 100.0
    snr_raw = avg_dbfs_raw - noise_floor_dbfs

    pace_history.append(wpm_raw)
    volume_history.append(avg_dbfs_raw)
    pitch_history.append(pitch_range_raw)
    silence_history.append(silence_pct_raw)

    wpm = _median_or_default(pace_history, wpm_raw)
    avg_dbfs = _median_or_default(volume_history, avg_dbfs_raw)
    pitch_range = _median_or_default(pitch_history, pitch_range_raw)
    silence_pct = _median_or_default(silence_history, silence_pct_raw)
    snr_db = avg_dbfs - noise_floor_dbfs

    thresholds = get_dynamic_thresholds()

    pace_fb = pace_feedback(wpm, speaking_time, thresholds)
    volume_fb = volume_feedback(avg_dbfs, snr_db, thresholds)
    pause_fb = pause_feedback(long_pauses, silence_pct, thresholds)
    pitch_fb = pitch_feedback(pitch_range, voiced_ratio, thresholds)

    overall, headline, messages = overall_feedback(pace_fb, volume_fb, pause_fb, pitch_fb)

    return {
        "metrics": {
            "wpm": round(wpm_raw, 1),
            "wpm_smoothed": round(wpm, 1),
            "avg_dbfs": round(avg_dbfs_raw, 1),
            "avg_dbfs_smoothed": round(avg_dbfs, 1),
            "snr_db": round(snr_raw, 1),
            "snr_db_smoothed": round(snr_db, 1),
            "pitch_range": round(pitch_range_raw, 1),
            "pitch_range_smoothed": round(pitch_range, 1),
            "voiced_ratio": round(voiced_ratio, 3),
            "long_pauses": long_pauses,
            "silence_pct": round(silence_pct_raw, 1),
            "silence_pct_smoothed": round(silence_pct, 1),
            "speaking_time_s": round(speaking_time, 2),
            "noise_floor_dbfs": round(noise_floor_dbfs, 1),
        },
        "status": {
            "overall": overall,
            "headline": headline,
            "pace": pace_fb["label"],
            "volume": volume_fb["label"],
            "pauses": pause_fb["label"],
            "pitch": pitch_fb["label"],
        },
        "messages": messages,
        "raw_alerts": [m["text"] for m in messages if m["severity"] != "ok"],
        "thresholds": {k: round(v, 2) for k, v in thresholds.items()},
        "baseline": {k: round(v, 2) for k, v in user_baseline.items()},
    }


def fmt_live_alerts(r: dict[str, Any]) -> str:
    status = r["status"]
    messages = r["messages"]

    lines = [f"{status['overall']}: {status['headline']}"]

    for msg in messages:
        if msg["severity"] != "ok":
            lines.append(f"{severity_prefix(msg['severity'])} {msg['area'].capitalize()}: {msg['short']}")

    return "\n".join(lines)


def fmt(r: dict[str, Any]) -> str:
    m = r["metrics"]
    s = r["status"]

    lines = [
        f"Overall: {s['overall']}",
        s["headline"],
        "",
        f"Pace:    {s['pace']}",
        f"Volume:  {s['volume']}",
        f"Pauses:  {s['pauses']}",
        f"Variety: {s['pitch']}",
    ]

    if SHOW_RAW_METRICS:
        lines.extend([
            "",
            f"Estimated pace: {m['wpm_smoothed']:.0f} WPM",
            f"Volume level:   {m['avg_dbfs_smoothed']:.0f} dBFS  (SNR {m['snr_db_smoothed']:.0f} dB)",
            f"Pitch range:    {m['pitch_range_smoothed']:.0f} Hz",
            f"Silence:        {m['silence_pct_smoothed']:.0f}%",
        ])

    return "\n".join(lines)


# ============================================================
# Session stats
# ============================================================

class SessionStats:
    def __init__(self):
        self.t0 = time.time()
        self.wpm: list[float] = []
        self.dbfs: list[float] = []
        self.snr: list[float] = []
        self.pitch: list[float] = []
        self.sil: list[float] = []
        self.overall: list[str] = []
        self.headlines: list[str] = []

        self.area_counts = {
            "pace_watch": 0,
            "pace_alert": 0,
            "volume_watch": 0,
            "volume_alert": 0,
            "pauses_watch": 0,
            "pauses_alert": 0,
            "pitch_watch": 0,
            "pitch_alert": 0,
        }

    def add(self, r: dict[str, Any]):
        m = r["metrics"]
        self.wpm.append(m.get("wpm_smoothed", m.get("wpm", 0.0)))
        self.dbfs.append(m.get("avg_dbfs_smoothed", m.get("avg_dbfs", -80.0)))
        self.snr.append(m.get("snr_db_smoothed", m.get("snr_db", 0.0)))
        self.pitch.append(m.get("pitch_range_smoothed", m.get("pitch_range", 0.0)))
        self.sil.append(m.get("silence_pct_smoothed", m.get("silence_pct", 0.0)))
        self.overall.append(r["status"]["overall"])
        self.headlines.append(r["status"]["headline"])

        for msg in r["messages"]:
            key = f"{msg['area']}_{msg['severity']}"
            if key in self.area_counts:
                self.area_counts[key] += 1

    def _med(self, x: list[float]) -> float:
        return round(float(np.median(x)), 1) if x else 0.0

    def _top_issue(self) -> str | None:
        ranked = sorted(self.area_counts.items(), key=lambda kv: kv[1], reverse=True)
        if not ranked or ranked[0][1] == 0:
            return None
        return ranked[0][0]

    def _what_went_well(self) -> list[str]:
        good: list[str] = []

        wpm_med = self._med(self.wpm)
        snr_med = self._med(self.snr)
        pitch_med = self._med(self.pitch)
        sil_med = self._med(self.sil)

        thresholds = get_dynamic_thresholds()

        if thresholds["slow_wpm"] <= wpm_med <= thresholds["fast_wpm"]:
            good.append("Your pace was generally in a comfortable range.")

        if snr_med >= MIN_SNR_DB and self._med(self.dbfs) <= thresholds["loud_dbfs"]:
            good.append("Your volume was usually easy to hear.")

        if pitch_med >= thresholds["monotone_hz"] + 8:
            good.append("You showed healthy vocal variety.")

        if thresholds["pause_dense_pct"] <= sil_med <= thresholds["pause_heavy_pct"] and self.area_counts["pauses_alert"] == 0:
            good.append("Your pauses were mostly natural.")

        if not good:
            good.append("You maintained a consistent speaking pattern across the session.")

        return good

    def _areas_to_improve(self) -> list[str]:
        improve: list[str] = []

        if self.area_counts["pace_alert"] > 0:
            improve.append("Your pace ran fast or slow enough at times to affect clarity.")
        elif self.area_counts["pace_watch"] > 0:
            improve.append("Your pace drifted a little outside the ideal range at times.")

        if self.area_counts["volume_alert"] > 0:
            improve.append("Your volume sometimes made you hard to hear.")
        elif self.area_counts["volume_watch"] > 0:
            improve.append("Your volume could be a bit more consistent.")

        if self.area_counts["pauses_alert"] > 0:
            improve.append("Some pauses were longer than ideal.")
        elif self.area_counts["pauses_watch"] > 0:
            improve.append("Your pacing could flow a little more smoothly between ideas.")

        if self.area_counts["pitch_alert"] > 0:
            improve.append("Your voice sounded flat at times and could use stronger emphasis.")
        elif self.area_counts["pitch_watch"] > 0:
            improve.append("You could sound more dynamic by adding vocal variation and emphasis.")

        return improve

    def _next_step(self) -> str:
        top = self._top_issue()
        mapping = {
            "pace_alert": "Practice speaking in shorter phrases and let each sentence finish before starting the next.",
            "pace_watch": "Aim for a steadier pace by giving key ideas a brief beat before moving on.",
            "volume_alert": "Practice projecting from a steady, supported voice rather than pushing harder.",
            "volume_watch": "Try speaking slightly more forward and consistent in volume.",
            "pauses_alert": "Work on restarting more quickly after pauses so the message keeps moving.",
            "pauses_watch": "Practice linking one idea to the next with smoother transitions.",
            "pitch_alert": "Choose a few key words per sentence to stress more clearly.",
            "pitch_watch": "Add a little more inflection to important phrases.",
        }
        return mapping.get(top, "Keep practicing with steady pace, clear volume, and natural emphasis.")

    def summary(self) -> dict[str, Any]:
        session_s = round(time.time() - self.t0, 1)

        return {
            "session_s": session_s,
            "windows": len(self.wpm),
            "medians": {
                "estimated_wpm": self._med(self.wpm),
                "avg_dbfs": self._med(self.dbfs),
                "snr_db": self._med(self.snr),
                "pitch_range_hz": self._med(self.pitch),
                "silence_pct": self._med(self.sil),
            },
            "issue_counts": self.area_counts,
            "what_went_well": self._what_went_well(),
            "areas_to_improve": self._areas_to_improve(),
            "next_step": self._next_step(),
            "baseline": {k: round(v, 2) for k, v in user_baseline.items()},
        }


# ============================================================
# Repetition guard
# ============================================================

class MessageRepeaterGuard:
    def __init__(self, cooldown_s: float = MESSAGE_COOLDOWN_SEC):
        self.cooldown_s = cooldown_s
        self.last_headline = ""
        self.last_print_t = 0.0

    def should_print(self, headline: str) -> bool:
        now = time.time()
        if headline != self.last_headline:
            self.last_headline = headline
            self.last_print_t = now
            return True

        if now - self.last_print_t >= self.cooldown_s:
            self.last_print_t = now
            return True

        return False


# ============================================================
# CLI entry point
# ============================================================

def main():
    global noise_floor_dbfs, user_baseline

    noise_floor_dbfs = calibrate_noise(NOISE_CALIBRATION_SEC)
    user_baseline = calibrate_user(USER_CALIBRATION_SEC)

    print("Monitoring — press Ctrl+C to stop.\n")

    last_update = 0.0
    stats = SessionStats()
    guard = MessageRepeaterGuard(MESSAGE_COOLDOWN_SEC)

    try:
        with sd.InputStream(
            samplerate=SR,
            channels=1,
            dtype="float32",
            blocksize=CHUNK,
            callback=audio_callback,
        ):
            while True:
                chunk = audio_q.get()
                buffer.extend(chunk)

                now = time.time()
                if now - last_update >= UPDATE_SEC and len(buffer) >= int(SR * MIN_ANALYZE_SEC):
                    y = np.array(buffer, dtype=np.float32)
                    y -= float(np.mean(y))

                    result = analyze(y)
                    if result:
                        stats.add(result)
                        if guard.should_print(result["status"]["headline"]):
                            print(fmt_live_alerts(result))
                            print("-" * 44)

                    last_update = now

    except (KeyboardInterrupt, SystemError):
        summary = stats.summary()

        print("\n=== SESSION SUMMARY ===")
        print(f"Session length: {summary['session_s']}s")
        print(f"Analysis windows: {summary['windows']}\n")

        print("What went well:")
        for item in summary["what_went_well"]:
            print(f"- {item}")

        print("\nAreas to improve:")
        if summary["areas_to_improve"]:
            for item in summary["areas_to_improve"]:
                print(f"- {item}")
        else:
            print("- No major delivery issues stood out.")

        print(f"\nNext step: {summary['next_step']}\n")

        print("Median metrics:")
        print(json.dumps(summary["medians"], indent=2))

        print("\nBaseline:")
        print(json.dumps(summary["baseline"], indent=2))

        if SAVE_SUMMARY_JSON:
            Path(SAVE_SUMMARY_JSON).write_text(
                json.dumps(summary, indent=2),
                encoding="utf-8",
            )
            print(f"\nSaved to: {SAVE_SUMMARY_JSON}")


if __name__ == "__main__":
    main()