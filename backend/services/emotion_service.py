import cv2
from deepface import DeepFace
from collections import Counter


def main():
    # -----------------------------
    # Setup
    # -----------------------------
    cap = cv2.VideoCapture(0)  # 0 = default webcam
    if not cap.isOpened():
        print("ERROR: Could not open webcam.")
        print("Fix: System Settings -> Privacy & Security -> Camera -> allow Terminal")
        return

    last_emotion = "..."
    frame_count = 0
    emotion_log = []

    print("Starting webcam. Press Q to quit.")

    # -----------------------------
    # Main loop
    # -----------------------------
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Analyze one frame per second (~30 FPS webcam)
        if frame_count % 30 == 0:
            try:
                result = DeepFace.analyze(
                    frame,
                    actions=["emotion"],
                    enforce_detection=False
                )
                last_emotion = result[0]["dominant_emotion"]
                emotion_log.append(last_emotion)
            except Exception as e:
                print("Emotion detection error:", e)

        # Display emotion on screen
        cv2.putText(
            frame,
            f"Emotion: {last_emotion}",
            (30, 50),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0, 255, 0),
            2
        )

        cv2.imshow("DeepFace Emotion Detection", frame)

        frame_count += 1

        # Press Q to quit
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    # -----------------------------
    # Cleanup
    # -----------------------------
    cap.release()
    cv2.destroyAllWindows()

    # -----------------------------
    # Emotion Summary
    # -----------------------------
    print("\nEmotion Summary:")
    counts = Counter(emotion_log)
    total = sum(counts.values())

    if total > 0:
        for emotion, count in counts.items():
            percent = (count / total) * 100
            print(f"{emotion}: {percent:.2f}%")
    else:
        print("No emotions recorded.")

def analyze_emotion_frame(frame):
    """Dominant emotion from DeepFace (same settings as the original working pipeline)."""
    from deepface import DeepFace

    result = DeepFace.analyze(
        frame,
        actions=["emotion"],
        enforce_detection=False,
    )
    return result[0]["dominant_emotion"]


if __name__ == "__main__":
   main()  