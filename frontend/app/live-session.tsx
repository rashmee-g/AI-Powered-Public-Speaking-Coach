import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import axios from "axios";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";

import CameraPreview from "../components/CameraPreview";
import FeedbackCard from "../components/FeedbackCard";
import StatusPill from "../components/StatusPill";
import AppHeader from "../components/AppHeader";
import {
  analyzeAudioChunk,
  analyzeContent,
  analyzeFrame,
  clearCoachWebSession,
  endSession,
  normalizeRouteParam,
  readCoachWebSession,
} from "../services/api";

const AUDIO_CHUNK_MS = 1800;
const FRAME_INTERVAL_MS = 2000;

function appendTranscriptSafe(previous: string, incoming: string): string {
  const prev = previous.trim();
  const next = incoming.trim();

  if (!next) return prev;
  if (!prev) return next;

  if (prev.toLowerCase().endsWith(next.toLowerCase())) {
    return prev;
  }

  const prevWords = prev.split(/\s+/);
  const nextWords = next.split(/\s+/);

  const maxOverlap = Math.min(prevWords.length, nextWords.length, 12);
  let overlap = 0;

  for (let k = maxOverlap; k >= 1; k--) {
    const prevTail = prevWords.slice(-k).join(" ").toLowerCase();
    const nextHead = nextWords.slice(0, k).join(" ").toLowerCase();
    if (prevTail === nextHead) {
      overlap = k;
      break;
    }
  }

  const merged = [...prevWords, ...nextWords.slice(overlap)].join(" ").trim();
  return merged;
}

export default function LiveSessionScreen() {
  const params = useLocalSearchParams<{
    sessionId: string;
    expectedText?: string;
    keyPoints?: string;
  }>();

  const webBootstrap = useMemo(() => readCoachWebSession(), []);

  const sessionId =
    normalizeRouteParam(params.sessionId) || webBootstrap?.sessionId || "";

  const expectedText =
    normalizeRouteParam(params.expectedText) ||
    String(webBootstrap?.expectedText ?? "");

  const keyPoints = useMemo(() => {
    const raw = normalizeRouteParam(params.keyPoints);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }
    return webBootstrap?.keyPoints ?? [];
  }, [params.keyPoints, webBootstrap]);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  const [audioPermissionGranted, setAudioPermissionGranted] = useState<boolean | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  const [liveTip, setLiveTip] = useState("Starting session...");
  const [speechStatus, setSpeechStatus] = useState("Starting mic...");
  const [bodyStatus, setBodyStatus] = useState("Waiting");
  const [emotionStatus, setEmotionStatus] = useState("Waiting");
  const [contentStatus, setContentStatus] = useState("Listening for content...");

  const [transcript, setTranscript] = useState("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [ending, setEnding] = useState(false);

  const isAnalyzingFrameRef = useRef(false);
  const isAnalyzingAudioRef = useRef(false);
  const sessionExpiredAlertShownRef = useRef(false);
  const audioLoopCancelledRef = useRef(false);

  useEffect(() => {
    sessionExpiredAlertShownRef.current = false;
  }, [sessionId]);

  const alertSessionExpiredOnce = () => {
    if (sessionExpiredAlertShownRef.current) return;
    sessionExpiredAlertShownRef.current = true;
    clearCoachWebSession();
    Alert.alert(
      "Session expired",
      "The server may have restarted. Go back and start a new practice session.",
      [{ text: "OK", onPress: () => router.replace("/") }]
    );
  };

  useEffect(() => {
    requestCameraPermission();

    (async () => {
      try {
        const permission = await Audio.requestPermissionsAsync();
        setAudioPermissionGranted(permission.granted);

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          staysActiveInBackground: false,
        });
      } catch (err) {
        console.log("Audio setup error:", err);
        setAudioPermissionGranted(false);
      }
    })();
  }, [requestCameraPermission]);

  useEffect(() => {
    if (!cameraPermission?.granted || !sessionId) return;

    const interval = setInterval(async () => {
      if (!cameraRef.current || isAnalyzingFrameRef.current) return;

      try {
        isAnalyzingFrameRef.current = true;

        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.45,
        });

        if (!photo?.base64) return;

        const result = await analyzeFrame(sessionId, photo.base64);

        setEmotionStatus(result.emotion || "Unknown");

        const bodyLabel =
          typeof result.body_summary === "string" && result.body_summary
            ? result.body_summary
            : result.body_feedback?.length
              ? result.body_feedback.slice(0, 2).join("; ")
              : "No posture issues detected";

        setBodyStatus(bodyLabel);
        setLiveTip(result.live_tip || "Keep going.");
      } catch (err: any) {
        console.log("Frame analysis error:", err?.response?.data || err?.message || err);
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          alertSessionExpiredOnce();
        }
      } finally {
        isAnalyzingFrameRef.current = false;
      }
    }, FRAME_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [cameraPermission?.granted, sessionId]);

  const startChunkRecording = async () => {
    if (!audioPermissionGranted) {
      setSpeechStatus("Mic permission needed");
      return false;
    }

    if (recordingRef.current) return true;

    try {
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();

      recordingRef.current = recording;
      setSpeechStatus("Listening");
      return true;
    } catch (err: any) {
      console.log("Start recording error:", err?.message || err);
      setSpeechStatus("Mic error");
      return false;
    }
  };

  const stopChunkAndAnalyze = async () => {
    if (isAnalyzingAudioRef.current) return;

    const recording = recordingRef.current;
    if (!recording) return;

    try {
      isAnalyzingAudioRef.current = true;
      setSpeechStatus("Analyzing");

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;

      if (!uri) {
        throw new Error("No audio URI returned.");
      }

      const result = await analyzeAudioChunk(sessionId, uri);
      console.log("audio chunk result:", result);

      setSpeechStatus(result?.status?.overall || "Analyzed");

      if (typeof result?.transcript === "string" && result.transcript.trim()) {
        setTranscript((prev) => appendTranscriptSafe(prev, result.transcript));
      }

      if (result?.ai_content_tip) {
        setContentStatus(result.ai_content_tip);
      } else if (result?.transcript) {
        setContentStatus("Transcript updated");
      }

      if (result?.live_tip) {
        setLiveTip(result.live_tip);
      }
    } catch (err: any) {
      console.log("Audio analyze error:", err?.response?.data || err?.message || err);

      if (axios.isAxiosError(err) && err.response?.status === 404) {
        alertSessionExpiredOnce();
        return;
      }

      if (axios.isAxiosError(err) && err.response?.status === 422) {
        setSpeechStatus("Audio upload rejected");
        return;
      }

      setSpeechStatus("Analyze error");
    } finally {
      isAnalyzingAudioRef.current = false;
    }
  };

  useEffect(() => {
    if (!sessionId || !audioPermissionGranted) return;

    audioLoopCancelledRef.current = false;

    const runAudioLoop = async () => {
      while (!audioLoopCancelledRef.current) {
        const started = await startChunkRecording();
        if (!started) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, AUDIO_CHUNK_MS));

        if (audioLoopCancelledRef.current) break;

        await stopChunkAndAnalyze();

        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };

    runAudioLoop();

    return () => {
      audioLoopCancelledRef.current = true;

      const recording = recordingRef.current;
      if (recording) {
        recording.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, [sessionId, audioPermissionGranted]);

  const onCheckContent = async () => {
    if (!transcript.trim()) {
      Alert.alert("Transcript needed", "Speak first so a transcript can be checked.");
      return;
    }

    if (!expectedText.trim()) {
      Alert.alert(
        "Outline needed",
        "Add your planned speech on the home screen so content can be compared."
      );
      return;
    }

    try {
      setLoadingContent(true);

      const res = await analyzeContent(
        sessionId,
        transcript,
        expectedText,
        keyPoints
      );

      if (res?.ai_content_tip) {
        setContentStatus(res.ai_content_tip);
      } else {
        setContentStatus(
          res?.topic_status === "on_topic" ? "On topic" : "Topic drift"
        );
      }

      setLiveTip(
        res?.ai_content_tip ||
          (res?.topic_status === "on_topic"
            ? "Your content matches your planned topic."
            : "Try staying closer to your outline.")
      );
    } catch (err: any) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        alertSessionExpiredOnce();
        return;
      }

      const detail = err?.response?.data?.detail;
      const message =
        typeof detail === "string"
          ? detail
          : err?.message || "Could not analyze content";

      Alert.alert("Content Error", message);
    } finally {
      setLoadingContent(false);
    }
  };

  const onEndSession = async () => {
    try {
      setEnding(true);
      audioLoopCancelledRef.current = true;

      const recording = recordingRef.current;
      if (recording) {
        await stopChunkAndAnalyze();
      }

      const res = await endSession(sessionId);

      clearCoachWebSession();

      router.push({
        pathname: "/summary",
        params: {
          data: JSON.stringify(res),
        },
      });
    } catch (err: any) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        alertSessionExpiredOnce();
        return;
      }

      Alert.alert(
        "End Session Error",
        err?.response?.data?.detail || err?.message || "Failed to end session"
      );
    } finally {
      setEnding(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
  
        {/* 🔥 Global Header (Home button + title) */}
        <AppHeader title="Live Practice Session" />
  
        {/* Session Info */}
        
        <Text style={styles.sessionText}>
          Session ID: {sessionId || "(none)"}
        </Text>
  
        {!sessionId ? (
          <Text style={styles.warn}>
            No active session. Go back and start a new one.
          </Text>
        ) : null}
  
        {/* 🎥 Camera */}
        <CameraPreview
          ref={cameraRef}
          hasPermission={cameraPermission ? cameraPermission.granted : null}
        />
  
        {/* 💬 Live Tip */}
        <FeedbackCard title="Live Coaching Tips" value={liveTip} />
  
        {/* 📊 Status Pills */}
        <View style={styles.pillsRow}>
          <StatusPill label="Speech" value={speechStatus} />
          <StatusPill label="Body" value={bodyStatus} />
          <StatusPill label="Emotion" value={emotionStatus} />
          <StatusPill label="Content" value={contentStatus} />
        </View>
  
        {/* 🧠 Transcript + Content */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Transcript / Content Check</Text>
  
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholder="Transcription will load here..."
            value={transcript}
            onChangeText={setTranscript}
            multiline
          />
  
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={onCheckContent}
            disabled={loadingContent}
          >
            <Text style={styles.secondaryBtnText}>
              {loadingContent ? "Checking..." : "Analyze Content"}
            </Text>
          </TouchableOpacity>
        </View>
  
        {/* 🔚 End Session */}
        <TouchableOpacity
          style={[styles.primaryBtn, ending && { opacity: 0.7 }]}
          onPress={onEndSession}
          disabled={ending}
        >
          <Text style={styles.primaryBtnText}>
            {ending ? "Ending..." : "End Session"}
          </Text>
        </TouchableOpacity>
  
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f6f7fb",
  },
  container: {
    padding: 20,
    paddingBottom: 50,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 6,
  },
  sessionText: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 16,
  },
  warn: {
    backgroundColor: "#fef3c7",
    color: "#92400e",
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    fontSize: 14,
    lineHeight: 20,
  },
  pillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 12,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 20,
    padding: 18,
    marginTop: 8,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#f3f4f6",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  multiline: {
    minHeight: 120,
    textAlignVertical: "top",
    marginBottom: 12,
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  primaryBtnText: {
    color: "white",
    fontWeight: "700",
    fontSize: 16,
  },
  secondaryBtn: {
    backgroundColor: "#e5e7eb",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: "#111827",
    fontWeight: "700",
    fontSize: 15,
  },
});