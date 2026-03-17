import cv2
import mediapipe as mp
import numpy as np
import sounddevice as sd
import librosa
import threading
import queue
import time
from collections import deque, Counter
from deepface import DeepFace

# --- CONFIGURATION ---
SR = 16000
CHUNK = int(SR * 0.03)
ANALYSIS_WINDOW_SEC = 3.0
UPDATE_INTERVAL_SEC = 1.0

# --- BASELINE THRESHOLDS ---
FAST_WPM = 190
SLOW_WPM = 110
LOUD_DB = -15.0
QUIET_DB = -40.0
FIDGET_THRESHOLD = 0.04 # Sensitivity for hand movement

class MultimodalAnalyzer:
    def __init__(self):
        self.audio_q = queue.Queue()
        self.audio_buffer = deque(maxlen=int(SR * ANALYSIS_WINDOW_SEC))
        self.noise_floor_db = -60.0
        
        # Stats tracking for final report
        self.stats_history = {"wpm": [], "dbfs": [], "emotions": []}
        self.alert_streaks = Counter() # To prevent flickering alerts
        
        self.current_metrics = {"wpm": 0, "dbfs": -60.0, "status": "Calibrating...", "active_alerts": []}
        
        self.mp_pose = mp.solutions.pose.Pose(min_detection_confidence=0.5)
        self.prev_wrist_pos = None
        
        self.last_emotion = "Neutral"
        self.running = False
        self.latest_frame = None

    def calibrate_noise(self, duration=1.5):
        print(f"Calibrating... stay quiet.")
        recording = sd.rec(int(duration * SR), samplerate=SR, channels=1)
        sd.wait()
        y = recording.flatten()
        rms = np.sqrt(np.mean(y**2) + 1e-12)
        self.noise_floor_db = 20 * np.log10(rms)
        print(f"Noise floor: {self.noise_floor_db:.1f} dB")

    def _emotion_worker(self):
        while self.running:
            if self.latest_frame is not None:
                try:
                    res = DeepFace.analyze(self.latest_frame, actions=['emotion'], enforce_detection=False, silent=True)
                    self.last_emotion = res[0]['dominant_emotion']
                    self.stats_history["emotions"].append(self.last_emotion)
                except: pass
            time.sleep(1.0)

    def _process_audio_metrics(self):
        if len(self.audio_buffer) < SR: return
        y = np.array(self.audio_buffer)
        rms = np.sqrt(np.mean(y**2) + 1e-12)
        dbfs = 20 * np.log10(rms)
        
        # Speech Detection logic
        speech_threshold = max(self.noise_floor_db + 15, -50.0)
        is_speaking = dbfs > speech_threshold
        
        temp_alerts = []
        wpm = 0

        if is_speaking:
            onset_env = librosa.onset.onset_strength(y=y, sr=SR)
            onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=SR, delta=0.1)
            wpm = (len(onsets) / ANALYSIS_WINDOW_SEC) * 60 / 1.45
            
            # Logic: Only add to stats if actually speaking
            self.stats_history["wpm"].append(wpm)
            self.stats_history["dbfs"].append(dbfs)

            # Threshold Checks
            if wpm > FAST_WPM: self.alert_streaks["FAST"] += 1
            else: self.alert_streaks["FAST"] = 0
            
            if wpm < SLOW_WPM and wpm > 20: self.alert_streaks["SLOW"] += 1
            else: self.alert_streaks["SLOW"] = 0

            if dbfs > LOUD_DB: self.alert_streaks["LOUD"] += 1
            else: self.alert_streaks["LOUD"] = 0

            if dbfs < QUIET_DB: self.alert_streaks["QUIET"] += 1
            else: self.alert_streaks["QUIET"] = 0

            # Only trigger UI alert if streak > 2 (2 seconds of consistent behavior)
            if self.alert_streaks["FAST"] > 2: temp_alerts.append("TOO FAST")
            if self.alert_streaks["SLOW"] > 2: temp_alerts.append("TOO SLOW")
            if self.alert_streaks["LOUD"] > 2: temp_alerts.append("TOO LOUD")
            if self.alert_streaks["QUIET"] > 2: temp_alerts.append("TOO QUIET")

        self.current_metrics = {
            "wpm": round(wpm, 1), "dbfs": round(dbfs, 1),
            "status": "Speaking" if is_speaking else "Silence",
            "active_alerts": temp_alerts
        }

    def _process_pose(self, frame):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.mp_pose.process(rgb)
        alerts = []
        if results.pose_landmarks:
            lm = results.pose_landmarks.landmark
            # 1. Slouching check
            if lm[0].y > (lm[11].y + lm[12].y)/2 - 0.05:
                alerts.append("SLOUCHING")
            
            # 2. Fidgeting check (Wrist movement variance)
            curr_wrist = np.array([lm[15].x, lm[15].y])
            if self.prev_wrist_pos is not None:
                dist = np.linalg.norm(curr_wrist - self.prev_wrist_pos)
                if dist > FIDGET_THRESHOLD:
                    alerts.append("FIDGETING")
            self.prev_wrist_pos = curr_wrist
        return alerts

    def audio_callback(self, indata, frames, time, status):
        self.audio_q.put(indata[:, 0].copy())

    def run_analysis(self):
        self.calibrate_noise()
        cap = cv2.VideoCapture(0)
        self.running = True
        
        threading.Thread(target=self._emotion_worker, daemon=True).start()
        stream = sd.InputStream(samplerate=SR, channels=1, callback=self.audio_callback)
        stream.start()
        
        last_audio_t = time.time()
        
        try:
            while self.running:
                ret, frame = cap.read()
                if not ret: break
                frame = cv2.flip(frame, 1)
                self.latest_frame = frame.copy()

                while not self.audio_q.empty():
                    self.audio_buffer.extend(self.audio_q.get())
                
                if time.time() - last_audio_t > UPDATE_INTERVAL_SEC:
                    self._process_audio_metrics()
                    last_audio_t = time.time()

                p_alerts = self._process_pose(frame)
                self._draw_ui(frame, p_alerts)
                
                cv2.imshow("Coach Analysis", frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    self.running = False
        finally:
            self.running = False
            stream.stop()
            cap.release()
            cv2.destroyAllWindows()
            self.print_summary()

    def _draw_ui(self, frame, pose_alerts):
        cv2.rectangle(frame, (10, 10), (380, 160), (0, 0, 0), -1)
        m = self.current_metrics
        audio_alerts = m.get("active_alerts", [])
        
        cv2.putText(frame, f"Emotion: {self.last_emotion}", (20, 45), 1, 1.3, (255, 255, 255), 2)
        
        pace_c = (0, 0, 255) if ("TOO FAST" in audio_alerts or "TOO SLOW" in audio_alerts) else (0, 255, 0)
        cv2.putText(frame, f"Pace:    {m['wpm']} WPM", (20, 75), 1, 1.3, pace_c, 2)
        
        vol_c = (0, 0, 255) if ("TOO LOUD" in audio_alerts or "TOO QUIET" in audio_alerts) else (255, 255, 255)
        cv2.putText(frame, f"Volume:  {m['dbfs']} dB", (20, 105), 1, 1.3, vol_c, 2)
        cv2.putText(frame, f"Status:  {m['status']}", (20, 135), 1, 1.3, (255, 200, 0), 2)

        for i, warning in enumerate(pose_alerts + audio_alerts):
            cv2.putText(frame, f"! {warning} !", (20, 210 + (i * 40)), 1, 2.0, (0, 0, 255), 3)

    def print_summary(self):
        print("\n" + "="*30)
        print("    SESSION COACHING REPORT")
        print("="*30)
        if self.stats_history["wpm"]:
            avg_wpm = np.mean(self.stats_history["wpm"])
            print(f"Average Pace:   {avg_wpm:.1f} WPM")
            print(f"Pace Quality:   {'Good' if 130 < avg_wpm < 160 else 'Needs Attention'}")
        
        if self.stats_history["emotions"]:
            top_emo = Counter(self.stats_history["emotions"]).most_common(1)[0][0]
            print(f"Primary Mood:   {top_emo.upper()}")
        
        print("="*30)

if __name__ == "__main__":
    analyzer = MultimodalAnalyzer()
    analyzer.run_analysis()
