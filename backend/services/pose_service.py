import cv2
import mediapipe as mp
import numpy as np

# -------------------------------
# MediaPipe setup (RUN ONCE)
# -------------------------------
mp_pose = mp.solutions.pose
# Sparse snapshots from the phone — static mode fits independent frames.
pose = mp_pose.Pose(
    static_image_mode=True,
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)


def _default_pose_state() -> dict:
    return {
        "prev_left_wrist": None,
        "fidget_score": 0.0,
        "head_positions": [],
        "hip_positions": [],
    }


def analyze_pose_frame(frame: np.ndarray, pose_state: dict | None = None) -> list[str]:
    """
    Expects BGR frame already mirrored to match the front camera preview.
    pose_state is per-session dict (mutated) so sparse frames build history correctly.
    """
    if pose_state is None:
        pose_state = _default_pose_state()

    prev_left_wrist = pose_state["prev_left_wrist"]
    fidget_score = pose_state["fidget_score"]
    head_positions: list = pose_state["head_positions"]
    hip_positions: list = pose_state["hip_positions"]

    feedback: list[str] = []

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = pose.process(rgb)

    if not results.pose_landmarks:
        pose_state["prev_left_wrist"] = prev_left_wrist
        pose_state["fidget_score"] = fidget_score * 0.92
        return feedback

    landmarks = results.pose_landmarks.landmark

    left_wrist = landmarks[mp_pose.PoseLandmark.LEFT_WRIST]
    if left_wrist.visibility > 0.5:
        if prev_left_wrist is not None:
            dx = left_wrist.x - prev_left_wrist.x
            dy = left_wrist.y - prev_left_wrist.y
            movement = (dx**2 + dy**2) ** 0.5
            if movement > 0.015:
                fidget_score += movement
        prev_left_wrist = left_wrist
    else:
        prev_left_wrist = None

    fidget_score *= 0.88
    if fidget_score > 0.12:
        feedback.append("Hand fidgeting detected")

    nose = landmarks[mp_pose.PoseLandmark.NOSE]
    head_positions.append(nose.x)
    if len(head_positions) > 24:
        head_positions.pop(0)
    if len(head_positions) > 8:
        head_var = float(np.var(head_positions))
        if head_var > 0.00035:
            feedback.append("Looking around")

    left_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER]
    right_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER]
    shoulder_y = (left_shoulder.y + right_shoulder.y) / 2
    if nose.y - shoulder_y > 0.075:
        feedback.append("Slouching posture")

    left_hip = landmarks[mp_pose.PoseLandmark.LEFT_HIP]
    right_hip = landmarks[mp_pose.PoseLandmark.RIGHT_HIP]
    hip_center_x = (left_hip.x + right_hip.x) / 2
    hip_positions.append(hip_center_x)
    if len(hip_positions) > 24:
        hip_positions.pop(0)
    if len(hip_positions) > 8:
        sway_var = float(np.var(hip_positions))
        if sway_var > 0.00035:
            feedback.append("Excessive body sway")

    pose_state["prev_left_wrist"] = prev_left_wrist
    pose_state["fidget_score"] = fidget_score

    return feedback


# -------------------------------
# OPTIONAL: RUN STANDALONE TEST
# -------------------------------
if __name__ == "__main__":
    cap = cv2.VideoCapture(0)
    state = _default_pose_state()

    print("Running pose detection test. Press Q to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame = cv2.flip(frame, 1)
        feedback = analyze_pose_frame(frame, state)

        y = 50
        for msg in feedback:
            cv2.putText(frame, msg, (30, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
            y += 40

        cv2.imshow("Pose Test", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
