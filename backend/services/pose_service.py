import cv2
import mediapipe as mp
import numpy as np

mp_pose = mp.solutions.pose
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
        "prev_right_wrist": None,
        "fidget_score": 0.0,
        "head_positions": [],
        "hip_positions": [],
    }


def _point_xy(landmark) -> np.ndarray:
    return np.array([float(landmark.x), float(landmark.y)], dtype=np.float32)


def analyze_pose_frame(frame: np.ndarray, pose_state: dict | None = None) -> list[str]:
    """
    Expects BGR frame already mirrored to match the front camera preview.
    pose_state is per-session dict (mutated) so sparse frames build history correctly.
    """
    if pose_state is None:
        pose_state = _default_pose_state()

    prev_left_wrist = pose_state.get("prev_left_wrist")
    prev_right_wrist = pose_state.get("prev_right_wrist")
    fidget_score = float(pose_state.get("fidget_score", 0.0))
    head_positions: list[float] = pose_state.get("head_positions", [])
    hip_positions: list[float] = pose_state.get("hip_positions", [])

    feedback: list[str] = []

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = pose.process(rgb)

    if not results.pose_landmarks:
        pose_state["prev_left_wrist"] = prev_left_wrist
        pose_state["prev_right_wrist"] = prev_right_wrist
        pose_state["fidget_score"] = fidget_score * 0.95
        pose_state["head_positions"] = head_positions
        return feedback

    landmarks = results.pose_landmarks.landmark

    # -------------------------------
    # Hand fidgeting detection
    # -------------------------------

    left_wrist = landmarks[mp_pose.PoseLandmark.LEFT_WRIST]
    right_wrist = landmarks[mp_pose.PoseLandmark.RIGHT_WRIST]

    total_movement = 0.0

    if left_wrist.visibility > 0.5:
        curr_left = _point_xy(left_wrist)
        if prev_left_wrist is not None:
            total_movement += float(np.linalg.norm(curr_left - prev_left_wrist))
        prev_left_wrist = curr_left
    else:
        prev_left_wrist = None

    if right_wrist.visibility > 0.5:
        curr_right = _point_xy(right_wrist)
        if prev_right_wrist is not None:
            total_movement += float(np.linalg.norm(curr_right - prev_right_wrist))
        prev_right_wrist = curr_right
    else:
        prev_right_wrist = None

    # More sensitive accumulation
    if total_movement > 0.008:
        fidget_score += total_movement * 1.5

    # Slower decay so motion builds across sparse frames
    fidget_score *= 0.95

    if fidget_score > 0.06:
        feedback.append("Hand fidgeting detected")

    print("FIDGET DEBUG:", {
    "total_movement": round(total_movement, 4),
    "fidget_score": round(fidget_score, 4),
    })
    
    # -------------------------------
    # Looking around
    # -------------------------------
    nose = landmarks[mp_pose.PoseLandmark.NOSE]
    head_positions.append(float(nose.x))
    if len(head_positions) > 24:
        head_positions.pop(0)

    if len(head_positions) > 8:
        head_var = float(np.var(head_positions))
        if head_var > 0.00035:
            feedback.append("Looking around")

    # -------------------------------
    # Slouching posture
    # -------------------------------
    left_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER]
    right_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER]
    shoulder_y = (left_shoulder.y + right_shoulder.y) / 2.0

    if nose.y - shoulder_y > 0.075:
        feedback.append("Slouching posture")

    # -------------------------------
    # Body sway
    # -------------------------------
    left_hip = landmarks[mp_pose.PoseLandmark.LEFT_HIP]
    right_hip = landmarks[mp_pose.PoseLandmark.RIGHT_HIP]
    hip_center_x = float((left_hip.x + right_hip.x) / 2.0)

    hip_positions.append(hip_center_x)
    if len(hip_positions) > 24:
        hip_positions.pop(0)

    if len(hip_positions) > 8:
        sway_var = float(np.var(hip_positions))
        if sway_var > 0.00035:
            feedback.append("Excessive body sway")

    pose_state["prev_left_wrist"] = prev_left_wrist
    pose_state["prev_right_wrist"] = prev_right_wrist
    pose_state["fidget_score"] = fidget_score
    pose_state["head_positions"] = head_positions
    pose_state["hip_positions"] = hip_positions

    return feedback


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
            cv2.putText(
                frame,
                msg,
                (30, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 0, 255),
                2,
            )
            y += 40

        cv2.imshow("Pose Test", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()