import os
from google.cloud import speech
from google.oauth2 import service_account
from sentence_transformers import SentenceTransformer, util

model = SentenceTransformer("all-MiniLM-L6-v2")

GOOGLE_CREDS_PATH = "/Users/prachipatel/Capstone/backend/speech-key.json"


def transcribe_audio(audio_file):
    if not os.path.exists(GOOGLE_CREDS_PATH):
        raise FileNotFoundError(f"Google credentials file not found: {GOOGLE_CREDS_PATH}")

    credentials = service_account.Credentials.from_service_account_file(
        GOOGLE_CREDS_PATH
    )
    client = speech.SpeechClient(credentials=credentials)

    with open(audio_file, "rb") as f:
        content = f.read()

    audio = speech.RecognitionAudio(content=content)

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=16000,
        language_code="en-US",
        enable_automatic_punctuation=True,
        model="latest_long",
    )

    response = client.recognize(config=config, audio=audio)

    transcript_parts = []
    for result in response.results:
        if result.alternatives:
            transcript_parts.append(result.alternatives[0].transcript)

    return " ".join(transcript_parts).strip()

def analyze_content(transcript, expected_text, key_points):
    transcript = (transcript or "").strip()
    expected_text = (expected_text or "").strip()
    key_points = key_points or []

    if not transcript:
        return {
            "transcript": "",
            "similarity_score": 0.0,
            "missed_points": key_points,
            "topic_status": "no_content",
            "ai_content_tip": "Not enough spoken content yet.",
        }

    if not expected_text:
        return {
            "transcript": transcript,
            "similarity_score": 0.0,
            "missed_points": key_points,
            "topic_status": "not_checked",
            "ai_content_tip": "Transcript captured, but no expected speech was provided.",
        }

    if len(transcript.split()) < 8:
        return {
            "transcript": transcript,
            "similarity_score": 0.0,
            "missed_points": key_points,
            "topic_status": "no_content",
            "ai_content_tip": "Keep speaking a little longer so I can evaluate your content more accurately.",
        }

    spoken_embedding = model.encode(transcript, convert_to_tensor=True)
    expected_embedding = model.encode(expected_text, convert_to_tensor=True)

    raw_similarity = util.cos_sim(spoken_embedding, expected_embedding).item()
    similarity_score = max(0.0, raw_similarity)

    transcript_lower = transcript.lower()
    missed_points = [kp for kp in key_points if str(kp).lower() not in transcript_lower]

    topic_status = "topic_drift" if similarity_score < 0.6 else "on_topic"

    if similarity_score < 0.6:
        ai_content_tip = "Try staying closer to your planned message."
    elif missed_points:
        ai_content_tip = "You stayed on topic, but try to include the missing key points."
    else:
        ai_content_tip = "You stayed on topic and covered the key points well."

    return {
        "transcript": transcript,
        "similarity_score": round(similarity_score, 3),
        "missed_points": missed_points,
        "topic_status": topic_status,
        "ai_content_tip": ai_content_tip,
    }