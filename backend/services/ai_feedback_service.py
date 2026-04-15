from __future__ import annotations

from typing import Any


def _clean_text(text: str) -> str:
    return " ".join(text.lower().strip().split())


def _match_key_points(transcript: str, key_points: list[str]) -> tuple[list[str], list[str]]:
    """
    Simple keyword/phrase matching.
    Returns (covered_points, missed_points).
    """
    transcript_lower = _clean_text(transcript)

    covered: list[str] = []
    missed: list[str] = []

    for kp in key_points:
        kp_clean = _clean_text(kp)
        if kp_clean and kp_clean in transcript_lower:
            covered.append(kp)
        else:
            missed.append(kp)

    return covered, missed


def _build_delivery_tip(metrics: dict[str, Any]) -> str:
    wpm = float(metrics.get("wpm_smoothed", metrics.get("wpm", 0)) or 0)
    silence = float(metrics.get("silence_pct_smoothed", metrics.get("silence_pct", 0)) or 0)
    pitch = float(metrics.get("pitch_range_smoothed", metrics.get("pitch_range", 0)) or 0)
    avg_dbfs = float(metrics.get("avg_dbfs_smoothed", metrics.get("avg_dbfs", 0)) or 0)

    issues: list[tuple[str, str]] = []

    if wpm > 185:
        issues.append((
            "pace",
            f"Your pace is fast at about {wpm:.0f} WPM, so slow down slightly to make each point land more clearly."
        ))
    elif 0 < wpm < 110:
        issues.append((
            "pace",
            f"Your pace is a little slow at about {wpm:.0f} WPM, so try adding a bit more energy and forward movement."
        ))

    if silence > 35:
        issues.append((
            "pauses",
            f"You have quite a few long pauses right now ({silence:.0f}% silence), so try connecting ideas more smoothly."
        ))
    elif 0 < silence < 5:
        issues.append((
            "pauses",
            "Your speech is very dense with very few pauses, so add a little more breathing room between ideas."
        ))

    if 0 < pitch < 20:
        issues.append((
            "pitch",
            f"Your vocal variety is limited right now (pitch range about {pitch:.0f} Hz), so emphasize key words more."
        ))

    if avg_dbfs < -35:
        issues.append((
            "volume",
            f"Your volume seems low at about {avg_dbfs:.1f} dBFS, so speak a bit more clearly and forward."
        ))
    elif avg_dbfs > -12:
        issues.append((
            "volume",
            f"Your volume is strong at about {avg_dbfs:.1f} dBFS, but back off slightly so it sounds controlled."
        ))

    if not issues:
        return "Your delivery sounds steady in this segment. Keep the same pace and stay intentional with emphasis."

    priority = {
        "pace": 4,
        "pauses": 3,
        "pitch": 2,
        "volume": 1,
    }
    issues.sort(key=lambda item: priority.get(item[0], 0), reverse=True)

    return issues[0][1]


def _build_content_tip(
    transcript: str,
    expected_text: str,
    key_points: list[str],
) -> str:
    covered, missed = _match_key_points(transcript, key_points)

    if not expected_text.strip() and not key_points:
        return "Content guidance is limited because no outline or key points were provided."

    if key_points:
        if len(covered) == len(key_points):
            return "You are covering your key points well in this segment."
        if covered and missed:
            return (
                f"You touched on {', '.join(covered)}, but you have not clearly covered "
                f"{', '.join(missed)} yet."
            )
        return f"You have not clearly covered these key points yet: {', '.join(missed)}."

    # Fallback when only expected_text exists
    transcript_len = len(transcript.split())
    expected_len = len(expected_text.split())

    if transcript_len < max(8, expected_len * 0.15):
        return "There is not enough spoken content yet to judge alignment with your outline."

    return "Compare this segment to your outline to make sure your main planned ideas are coming through."


def _build_positive_note(metrics: dict[str, Any], transcript: str) -> str:
    wpm = float(metrics.get("wpm_smoothed", metrics.get("wpm", 0)) or 0)
    pitch = float(metrics.get("pitch_range_smoothed", metrics.get("pitch_range", 0)) or 0)

    if 120 <= wpm <= 170:
        return "Your speaking pace is in a comfortable range."
    if pitch >= 25:
        return "You are showing some good vocal variety."
    if len(transcript.split()) >= 12:
        return "You are giving enough spoken content to analyze clearly."

    return "Good start—keep going so I can give more specific feedback."


def generate_ai_feedback(
    transcript: str,
    expected_text: str,
    key_points: list[str],
    metrics: dict[str, Any],
) -> dict[str, str]:
    transcript = transcript.strip()
    expected_text = expected_text.strip()
    key_points = key_points or []

    if not transcript:
        return {
            "live_tip": "Keep speaking so I can give more personalized feedback.",
            "content_tip": "Not enough content yet.",
            "positive_note": "Good start.",
        }

    live_tip = _build_delivery_tip(metrics)
    content_tip = _build_content_tip(transcript, expected_text, key_points)
    positive_note = _build_positive_note(metrics, transcript)

    return {
        "live_tip": live_tip,
        "content_tip": content_tip,
        "positive_note": positive_note,
    }