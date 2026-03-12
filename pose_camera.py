import cv2
import mediapipe as mp
import numpy as np

# -------------------------------
# MediaPipe setup
# -------------------------------
mp_pose = mp.solutions.pose
pose = mp_pose.Pose(
    static_image_mode=False,
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)
mp_draw = mp.solutions.drawing_utils

# -------------------------------
# Video capture
# -------------------------------
cap = cv2.VideoCapture(0)

# -------------------------------
# History buffers & state
# -------------------------------
MAX_HISTORY = 60  # ~2 seconds at 30 FPS

pose_history = []

prev_left_wrist = None
fidget_score = 0.0

head_positions = []
hip_positions = []

# -------------------------------
# Main loop
# -------------------------------
while True:

    ret, frame = cap.read()
    if not ret:
        break

    # Mirror view
    frame = cv2.flip(frame, 1)

    # Convert for mediapipe
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = pose.process(rgb)

    if results.pose_landmarks:

        landmarks = results.pose_landmarks.landmark

        # Draw skeleton
        mp_draw.draw_landmarks(
            frame,
            results.pose_landmarks,
            mp_pose.POSE_CONNECTIONS
        )

        # -------------------------------
        # Store pose history
        # -------------------------------
        pose_history.append(landmarks)
        if len(pose_history) > MAX_HISTORY:
            pose_history.pop(0)

        # -------------------------------
        # FEATURE 1: Hand fidgeting
        # -------------------------------
        left_wrist = landmarks[mp_pose.PoseLandmark.LEFT_WRIST]

        # Only run if wrist is visible
        if left_wrist.visibility > 0.6:

            if prev_left_wrist is not None:

                dx = left_wrist.x - prev_left_wrist.x
                dy = left_wrist.y - prev_left_wrist.y
                movement = (dx**2 + dy**2) ** 0.5

                # Ignore tiny natural motion
                if movement > 0.02:
                    fidget_score += movement

            prev_left_wrist = left_wrist

        else:
            prev_left_wrist = None

        # Slowly decay score
        fidget_score *= 0.9

        # Trigger warning
        if fidget_score > 0.15:
            cv2.putText(
                frame,
                "Hand fidgeting detected",
                (30, 50),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                (0, 0, 255),
                2
            )

        # -------------------------------
        # FEATURE 2: Looking around
        # -------------------------------
        nose = landmarks[mp_pose.PoseLandmark.NOSE]
        head_positions.append(nose.x)

        if len(head_positions) > 30:
            head_positions.pop(0)

        if len(head_positions) > 10:
            head_var = np.var(head_positions)

            if head_var > 0.0005:
                cv2.putText(
                    frame,
                    "Looking around",
                    (30, 90),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.9,
                    (0, 0, 255),
                    2
                )

        # -------------------------------
        # FEATURE 3: Posture (slouching)
        # -------------------------------
        left_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER]
        right_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER]

        shoulder_y = (left_shoulder.y + right_shoulder.y) / 2

        if nose.y - shoulder_y > 0.08:
            cv2.putText(
                frame,
                "Slouching posture",
                (30, 130),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                (0, 0, 255),
                2
            )

        # -------------------------------
        # FEATURE 4: Body sway
        # -------------------------------
        left_hip = landmarks[mp_pose.PoseLandmark.LEFT_HIP]
        right_hip = landmarks[mp_pose.PoseLandmark.RIGHT_HIP]

        hip_center_x = (left_hip.x + right_hip.x) / 2
        hip_positions.append(hip_center_x)

        if len(hip_positions) > 30:
            hip_positions.pop(0)

        if len(hip_positions) > 10:

            sway_var = np.var(hip_positions)

            if sway_var > 0.0004:
                cv2.putText(
                    frame,
                    "Excessive body sway",
                    (30, 170),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.9,
                    (0, 0, 255),
                    2
                )

    # -------------------------------
    # Display frame
    # -------------------------------
    cv2.imshow("Body Language Analysis", frame)

    # Quit key
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break


# -------------------------------
# Session summary
# -------------------------------
print("\nSession Summary")
print("----------------")
print("Hand fidget score:", round(fidget_score, 4))
print("Head movement variance:", round(np.var(head_positions), 6) if head_positions else 0)
print("Body sway variance:", round(np.var(hip_positions), 6) if hip_positions else 0)


# -------------------------------
# Cleanup
# -------------------------------
cap.release()
cv2.destroyAllWindows()