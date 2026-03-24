import json
import queue
import time
from collections import deque
from pathlib import Path

import numpy as np
import sounddevice as sd
import librosa


# -------- thresholds --------
SR = 16000
CHUNK_MS = 30
CHUNK = int(SR * CHUNK_MS / 1000)

ANALYSIS_SEC = 3.0   # rolling window length
UPDATE_SEC = 0.5     # how often to emit a reading

# Pace
FAST_WPM = 260
SLOW_WPM = 110

# Volume 
HIGH_VOL_DBFS = -28.0   # clipping / shouting risk
MIN_SNR_DB = 12.0       # speech must be at least this far above noise floor

# Pauses
LONG_PAUSE_S = 1.5
MIN_SILENCE_S = 0.25
TOP_DB = 28.0

# Monotone
MONOTONE_HZ = 25.0
MIN_VOICED = 0.25

SAVE_SUMMARY_JSON: str | None = None

# Output / UX
SHOW_RAW_METRICS = True
MESSAGE_COOLDOWN_SEC = 3.0   # suppress repeating the same headline too often

# -------- initial buffer state --------
buffer: deque = deque(maxlen=int(SR * ANALYSIS_SEC))
audio_q: "queue.Queue[np.ndarray]" = queue.Queue()
noise_floor_dbfs: float = -60.0


def audio_callback(indata, frames, time_info, status):
    audio_q.put(indata[:, 0].copy())


# ------------------------------------------------------------------ #
#  Calibration                                                        #
# ------------------------------------------------------------------ #

def calibrate(duration_s: float = 1.5) -> float:
    print(f"Calibrating — stay quiet for {duration_s}s...")
    samples = []
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
        audio_q.get_nowait()

    if samples:
        y = np.concatenate(samples)
        rms = float(np.sqrt(np.mean(y ** 2) + 1e-12))
        db = float(20 * np.log10(rms))
        print(f"Noise floor: {db:.1f} dBFS\n")
        return db

    return -60.0


# ------------------------------------------------------------------ #
#  The four metric functions                                          #
# ------------------------------------------------------------------ #

def measure_pace(y_speech: np.ndarray, speaking_time_s: float) -> float:
    if speaking_time_s < 0.3 or y_speech.size < SR * 0.1:
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
        wait=int(SR * 0.08 / hop),
    )
    return float(len(onsets) / max(speaking_time_s, 1e-6) * 60 / 1.5)


def measure_volume(y_speech: np.ndarray) -> float:
    if y_speech.size == 0:
        return -80.0
    rms = float(np.sqrt(np.mean(y_speech ** 2) + 1e-12))
    return float(20 * np.log10(rms))


def measure_pauses(y: np.ndarray) -> tuple[int, float]:
    duration = len(y) / SR
    intervals = librosa.effects.split(y, top_db=TOP_DB)
    speech_segs = [(s / SR, e / SR) for s, e in intervals]

    silence_gaps = []
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
    if y_speech.size < SR * 0.2:
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


# ------------------------------------------------------------------ #
#  Extract speech-only audio                                          #
# ------------------------------------------------------------------ #

def speech_only(y: np.ndarray) -> tuple[np.ndarray, float]:
    intervals = librosa.effects.split(y, top_db=TOP_DB)
    parts = [y[s:e] for s, e in intervals if (e - s) > int(SR * 0.05)]
    if not parts:
        return np.array([], dtype=np.float32), 0.0
    audio = np.concatenate(parts)
    speaking_time = sum((e - s) / SR for s, e in intervals)
    return audio, speaking_time


# ------------------------------------------------------------------ #
#  User-friendly interpretation helpers                               #
# ------------------------------------------------------------------ #

def sev_rank(severity: str) -> int:
    return {"ok": 0, "watch": 1, "alert": 2}.get(severity, 0)


def pace_feedback(wpm: float, speaking_time: float) -> dict:
    if speaking_time < 0.5 or wpm <= 0:
        return {
            "label": "Waiting for more speech",
            "severity": "ok",
            "message": "Keep speaking so I can judge your pace.",
            "short": "Listening for pace",
        }

    if wpm > FAST_WPM:
        return {
            "label": "Fast",
            "severity": "alert",
            "message": "Slow down a little so each phrase lands more clearly.",
            "short": "Slow down a little",
        }

    if wpm < SLOW_WPM:
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


def volume_feedback(avg_dbfs: float, snr_db: float, low_vol_threshold: float) -> dict:
    if avg_dbfs > HIGH_VOL_DBFS:
        return {
            "label": "Too loud",
            "severity": "alert",
            "message": "Back off the volume a bit.",
            "short": "Back off the volume a bit",
        }

    if avg_dbfs < low_vol_threshold or snr_db < MIN_SNR_DB:
        if snr_db < MIN_SNR_DB - 4:
            label = "Hard to hear"
            msg = "Speak clearly louder so your voice stands out from the room noise."
            short = "Speak louder"
            severity = "alert"
        else:
            label = "Slightly quiet"
            msg = "Speak a bit louder."
            short = "Speak a bit louder"
            severity = "watch"

        return {
            "label": label,
            "severity": severity,
            "message": msg,
            "short": short,
        }

    return {
        "label": "Good",
        "severity": "ok",
        "message": "Your volume is in a healthy range.",
        "short": "Volume is in a healthy range",
    }


def pause_feedback(long_pauses: int, silence_pct: float) -> dict:
    if long_pauses > 0:
        if long_pauses >= 2:
            return {
                "label": "Long pauses",
                "severity": "alert",
                "message": "Your pauses are running a bit long. Try keeping your thought flow moving.",
                "short": "Keep pauses shorter",
            }
        return {
            "label": "One long pause",
            "severity": "watch",
            "message": "You had a long pause. Try a slightly quicker restart after the pause.",
            "short": "Quicker restart after pauses",
        }

    if silence_pct >= 40:
        return {
            "label": "Pause-heavy",
            "severity": "watch",
            "message": "There is quite a bit of silence. Try linking ideas more smoothly.",
            "short": "Link ideas more smoothly",
        }

    if silence_pct <= 8:
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


def pitch_feedback(pitch_range: float, voiced_ratio: float) -> dict:
    if voiced_ratio < MIN_VOICED:
        return {
            "label": "Not enough voiced audio yet",
            "severity": "ok",
            "message": "Keep speaking so I can judge vocal variety.",
            "short": "Listening for vocal variety",
        }

    if pitch_range < 15:
        return {
            "label": "Very flat",
            "severity": "alert",
            "message": "Your voice sounds very flat. Emphasize key words more clearly.",
            "short": "Emphasize key words more",
        }

    if pitch_range < MONOTONE_HZ:
        return {
            "label": "Flat",
            "severity": "watch",
            "message": "Add more vocal variety and emphasis to key words.",
            "short": "Add more vocal variety",
        }

    if pitch_range < MONOTONE_HZ + 10:
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

def severity_prefix(severity: str) -> str:
    return {
        "ok": "[OK]",
        "watch": "[WARNING]",
        "alert": "[ALERT]",
    }.get(severity, "[INFO]")


def fmt_live_alerts(r: dict) -> str:
    status = r["status"]
    messages = r["messages"]

    lines = [f"{status['overall']}: {status['headline']}"]

    for msg in messages:
        lines.append(f"{severity_prefix(msg['severity'])} {msg['area'].capitalize()}: {msg['short']}")

    return "\n".join(lines)


def overall_feedback(pace_fb: dict, volume_fb: dict, pause_fb: dict, pitch_fb: dict) -> tuple[str, str, list[dict]]:
    messages = [
        {"area": "pace", "severity": pace_fb["severity"], "text": pace_fb["message"], "short": pace_fb["short"]},
        {"area": "volume", "severity": volume_fb["severity"], "text": volume_fb["message"], "short": volume_fb["short"]},
        {"area": "pauses", "severity": pause_fb["severity"], "text": pause_fb["message"], "short": pause_fb["short"]},
        {"area": "pitch", "severity": pitch_fb["severity"], "text": pitch_fb["message"], "short": pitch_fb["short"]},
    ]

    issues = [m for m in messages if m["severity"] != "ok"]
    issues.sort(key=lambda x: sev_rank(x["severity"]), reverse=True)

    if not issues:
        return "Good", "Good delivery overall.", issues

    top = issues[0]
    if top["severity"] == "alert":
        return "Needs attention", f"Main tip: {top['short']}.", issues

    return "Mostly good", f"Main tip: {top['short']}.", issues


# ------------------------------------------------------------------ #
#  Main analysis                                                      #
# ------------------------------------------------------------------ #

pace_history: deque = deque(maxlen=3)

def analyze(y: np.ndarray) -> dict | None:
    if len(y) / SR < 0.5:
        return None

    y_sp, speaking_time = speech_only(y)

    wpm = measure_pace(y_sp, speaking_time)
    avg_dbfs = measure_volume(y_sp)
    long_pauses, sil = measure_pauses(y)

    try:
        pitch_range, vr = measure_pitch_range(y_sp)
    except (SystemError, KeyboardInterrupt):
        raise KeyboardInterrupt

    snr = avg_dbfs - noise_floor_dbfs
    low_vol_threshold = noise_floor_dbfs + MIN_SNR_DB

    pace_history.append(wpm)
    pace_for_feedback = wpm
    if len(pace_history) == 3:
        if all(v > FAST_WPM for v in pace_history):
            pace_for_feedback = max(pace_history)
        elif all(v < SLOW_WPM for v in pace_history) and speaking_time > 0.5:
            pace_for_feedback = min(pace_history)
        else:
            pace_for_feedback = float(np.median(pace_history))

    pace_fb = pace_feedback(pace_for_feedback, speaking_time)
    volume_fb = volume_feedback(avg_dbfs, snr, low_vol_threshold)
    pause_fb = pause_feedback(long_pauses, sil * 100.0)
    pitch_fb = pitch_feedback(pitch_range, vr)

    overall, headline, messages = overall_feedback(pace_fb, volume_fb, pause_fb, pitch_fb)

    return {
        "metrics": {
            "wpm": round(wpm, 1),
            "avg_dbfs": round(avg_dbfs, 1),
            "snr_db": round(snr, 1),
            "pitch_range": round(pitch_range, 1),
            "voiced_ratio": round(vr, 3),
            "long_pauses": long_pauses,
            "silence_pct": round(sil * 100, 1),
            "speaking_time_s": round(speaking_time, 2),
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
        "raw_alerts": [m["text"] for m in messages],
    }


def fmt(r: dict) -> str:
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
            f"Estimated pace: {m['wpm']:.0f} WPM",
            f"Volume level:   {m['avg_dbfs']:.0f} dBFS  (SNR {m['snr_db']:.0f} dB)",
            f"Pitch range:    {m['pitch_range']:.0f} Hz",
            f"Silence:        {m['silence_pct']:.0f}%",
        ])

    return "\n".join(lines)


# ------------------------------------------------------------------ #
#  Session stats                                                      #
# ------------------------------------------------------------------ #

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

    def add(self, r: dict):
        m = r["metrics"]
        self.wpm.append(m["wpm"])
        self.dbfs.append(m["avg_dbfs"])
        self.snr.append(m["snr_db"])
        self.pitch.append(m["pitch_range"])
        self.sil.append(m["silence_pct"])
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
        good = []

        wpm_med = self._med(self.wpm)
        snr_med = self._med(self.snr)
        pitch_med = self._med(self.pitch)
        sil_med = self._med(self.sil)

        if SLOW_WPM <= wpm_med <= FAST_WPM:
            good.append("Your pace was generally in a comfortable range.")

        if snr_med >= MIN_SNR_DB and self._med(self.dbfs) <= HIGH_VOL_DBFS:
            good.append("Your volume was usually easy to hear.")

        if pitch_med >= MONOTONE_HZ + 10:
            good.append("You showed healthy vocal variety.")

        if 8 <= sil_med <= 40 and self.area_counts["pauses_alert"] == 0:
            good.append("Your pauses were mostly natural.")

        if not good:
            good.append("You maintained a consistent speaking pattern across the session.")

        return good

    def _areas_to_improve(self) -> list[str]:
        improve = []

        if self.area_counts["pace_alert"] > 0:
            improve.append("Your pace ran fast at times.")
        elif self.area_counts["pace_watch"] > 0:
            improve.append("Your pace drifted a little outside the ideal range at times.")

        if self.area_counts["volume_alert"] > 0:
            improve.append("Your volume sometimes made you hard to hear or overly forceful.")
        elif self.area_counts["volume_watch"] > 0:
            improve.append("Your volume could be a bit more consistent.")

        if self.area_counts["pauses_alert"] > 0:
            improve.append("Some pauses were longer than ideal.")
        elif self.area_counts["pauses_watch"] > 0:
            improve.append("Your pacing could flow a little more smoothly between ideas.")

        if self.area_counts["pitch_watch"] > 0 or self.area_counts["pitch_alert"] > 0:
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

    def summary(self) -> dict:
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
        }


# ------------------------------------------------------------------ #
#  Repetition control for live output                                 #
# ------------------------------------------------------------------ #

class MessageRepeaterGuard:
    def __init__(self, cooldown_s: float = 3.0):
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


# ------------------------------------------------------------------ #
#  Entry point                                                        #
# ------------------------------------------------------------------ #

def main():
    global noise_floor_dbfs
    noise_floor_dbfs = calibrate(1.5)

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
                if now - last_update >= UPDATE_SEC and len(buffer) >= int(SR * 0.5):
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

        if SAVE_SUMMARY_JSON:
            Path(SAVE_SUMMARY_JSON).write_text(
                json.dumps(summary, indent=2),
                encoding="utf-8",
            )
            print(f"\nSaved to: {SAVE_SUMMARY_JSON}")


if __name__ == "__main__":
    main()
