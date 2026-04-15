from google.cloud import speech
from sentence_transformers import SentenceTransformer, util

model = SentenceTransformer("all-MiniLM-L6-v2")


def transcribe_audio(audio_file):
    client = speech.SpeechClient()

    with open(audio_file, "rb") as f:
        content = f.read()

    audio = speech.RecognitionAudio(content=content)

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=16000,
        language_code="en-US",
    )

    response = client.recognize(config=config, audio=audio)

    transcript = ""
    for result in response.results:
        transcript += result.alternatives[0].transcript + " "

    return transcript.strip()


def analyze_content(transcript, expected_text, key_points):
    spoken_embedding = model.encode(transcript, convert_to_tensor=True)
    expected_embedding = model.encode(expected_text, convert_to_tensor=True)

    similarity_score = util.cos_sim(spoken_embedding, expected_embedding).item()

    transcript_lower = transcript.lower()
    missed_points = [kp for kp in key_points if kp.lower() not in transcript_lower]

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