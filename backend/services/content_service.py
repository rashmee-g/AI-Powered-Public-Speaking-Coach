from google.cloud import speech
from sentence_transformers import SentenceTransformer, util


# -----------------------------------
# SPEECH TO TEXT USING GOOGLE API
# -----------------------------------
def transcribe_audio(audio_file):

    client = speech.SpeechClient()

    with open(audio_file, "rb") as f:
        content = f.read()

    audio = speech.RecognitionAudio(content=content)

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=16000,
        language_code="en-US"
    )

    response = client.recognize(config=config, audio=audio)

    transcript = ""

    for result in response.results:
        transcript += result.alternatives[0].transcript + " "

    return transcript.strip()


# -----------------------------------
# SEMANTIC CONTENT ANALYSIS
# -----------------------------------
def analyze_content(transcript, expected_text, key_points):

    model = SentenceTransformer("all-MiniLM-L6-v2")

    spoken_embedding = model.encode(transcript, convert_to_tensor=True)
    expected_embedding = model.encode(expected_text, convert_to_tensor=True)

    similarity_score = util.cos_sim(spoken_embedding, expected_embedding).item()

    transcript_lower = transcript.lower()
    missed_points = [kp for kp in key_points if kp not in transcript_lower]

    print("\n--- TRANSCRIPT ---")
    print(transcript)

    print("\n--- CONTENT ANALYSIS RESULTS ---")
    print(f"Semantic Similarity Score: {similarity_score:.2f}")

    if similarity_score < 0.6:
        print("⚠️ Topic drift detected")
    else:
        print("✅ Speech stayed on topic")

    print("Missed Key Points:", missed_points)


# -----------------------------------
# EXPECTED CONTENT
# -----------------------------------
expected_text = """
Today I will talk about the impact of social media on mental health,
including anxiety, comparison culture, and ways to build healthy habits.
"""

key_points = [
    "anxiety",
    "comparison culture",
    "healthy habits"
]


# -----------------------------------
# MAIN EXECUTION
# -----------------------------------
if __name__ == "__main__":

    audio_file = "test_speech.wav"

    print("Transcribing speech using Google Speech-to-Text...")

    transcript = transcribe_audio(audio_file)

    analyze_content(transcript, expected_text, key_points)