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
import { MaterialCommunityIcons } from "@expo/vector-icons";
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
  isSessionExpiredError,
} from "../services/api";

const AUDIO_CHUNK_MS = 4000;
const FRAME_INTERVAL_MS = 2000;
const HISTORY_STORAGE_KEY = "capstoneCoachSessionHistory_v1";

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

  return [...prevWords, ...nextWords.slice(overlap)].join(" ").trim();
}

function readSavedReports() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeSavedReports(items: any[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch {}
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

      if (!sessionId) {
        throw new Error("No active session to end.");
      }

      const res = await endSession(sessionId);

      const savedItem = {
        sessionId,
        createdAt: new Date().toISOString(),
        expectedText,
        keyPoints,
        summary: res,
      };

      const existing = readSavedReports();
      const next = [savedItem, ...existing.filter((x: any) => x.sessionId !== sessionId)].slice(0, 20);
      writeSavedReports(next);

      clearCoachWebSession();

      router.push({
        pathname: "/summary",
        params: {
          data: JSON.stringify(res),
        },
      });
    } catch (err: any) {
      if (isSessionExpiredError(err)) {
        clearCoachWebSession();
        Alert.alert(
          "Session expired",
          "Please go back and start a new session.",
          [{ text: "OK", onPress: () => router.replace("/") }]
        );
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
        <View style={styles.navbar}>
          <AppHeader title="" />
        </View>

        <View style={styles.hero}>
          <View style={styles.heroTag}>
            <Text style={styles.heroTagText}>Live Practice Session</Text>
          </View>

          <Text style={styles.heroTitle}>Stay focused. Speak clearly.</Text>

          <Text style={styles.heroSubtitle}>
            Your live coaching session is active. Keep speaking and let SpeakEZ
            track your speech, body language, emotion, and content in real time.
          </Text>

          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <View style={[styles.statIconWrap, { backgroundColor: "#dbeafe" }]}>
                <MaterialCommunityIcons
                  name="microphone"
                  size={24}
                  color="#1D4ED8"
                />
              </View>
              <Text style={styles.statValue}>{speechStatus}</Text>
              <Text style={styles.statLabel}>Speech Status</Text>
            </View>

            <View style={styles.statCard}>
              <View style={[styles.statIconWrap, { backgroundColor: "#cffafe" }]}>
                <MaterialCommunityIcons
                  name="identifier"
                  size={24}
                  color="#0F766E"
                />
              </View>
              <Text style={styles.statValueSmall}>
                {sessionId ? sessionId.slice(0, 8) : "--"}
              </Text>
              <Text style={styles.statLabel}>Session ID</Text>
            </View>
          </View>
        </View>

        {!sessionId ? (
          <Text style={styles.warn}>
            No active session. Go back and start a new one.
          </Text>
        ) : null}

        <View style={styles.grid}>
          <View style={styles.leftCol}>
            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#dbeafe" }]}>
                  <MaterialCommunityIcons
                    name="video-outline"
                    size={22}
                    color="#1D4ED8"
                  />
                </View>
                <Text style={styles.panelTitle}>Live Camera Feed</Text>
              </View>

              <CameraPreview
                ref={cameraRef}
                hasPermission={cameraPermission ? cameraPermission.granted : null}
              />
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#e0f2fe" }]}>
                  <MaterialCommunityIcons
                    name="message-processing-outline"
                    size={22}
                    color="#0891B2"
                  />
                </View>
                <Text style={styles.panelTitle}>Live Coaching Tip</Text>
              </View>

              <FeedbackCard title="Current Guidance" value={liveTip} />
            </View>
          </View>

          <View style={styles.rightCol}>
            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#cffafe" }]}>
                  <MaterialCommunityIcons
                    name="chart-box-outline"
                    size={22}
                    color="#0891B2"
                  />
                </View>
                <Text style={styles.panelTitle}>Live Status</Text>
              </View>

              <View style={styles.pillsWrap}>
                <StatusPill label="Speech" value={speechStatus} />
                <StatusPill label="Body" value={bodyStatus} />
                <StatusPill label="Emotion" value={emotionStatus} />
                <StatusPill label="Content" value={contentStatus} />
              </View>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#dbeafe" }]}>
                  <MaterialCommunityIcons
                    name="brain"
                    size={22}
                    color="#1D4ED8"
                  />
                </View>
                <Text style={styles.panelTitle}>Transcript / Content Check</Text>
              </View>

              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Transcription will load here..."
                value={transcript}
                onChangeText={setTranscript}
                multiline
                placeholderTextColor="#94a3b8"
              />

              <TouchableOpacity
                style={[styles.secondaryBtn, loadingContent && styles.buttonDisabled]}
                onPress={onCheckContent}
                disabled={loadingContent}
              >
                <Text style={styles.secondaryBtnText}>
                  {loadingContent ? "Checking..." : "Analyze Content"}
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, ending && styles.buttonDisabled]}
              onPress={onEndSession}
              disabled={ending}
            >
              <Text style={styles.primaryBtnText}>
                {ending ? "Ending..." : "End Session"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#eef4ff",
  },

  container: {
    padding: 24,
    paddingBottom: 48,
  },

  navbar: {
    backgroundColor: "transparent",
    paddingVertical: 0,
    paddingHorizontal: 0,
    marginBottom: 24,
  },

  hero: {
    backgroundColor: "#ffffff",
    borderRadius: 32,
    padding: 34,
    marginBottom: 28,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },

  heroTag: {
    backgroundColor: "#dbeafe",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginBottom: 18,
  },

  heroTagText: {
    color: "#2563eb",
    fontWeight: "700",
    fontSize: 13,
  },

  heroTitle: {
    fontSize: 42,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#111827",
    textAlign: "center",
    lineHeight: 48,
    marginBottom: 14,
  },

  heroSubtitle: {
    fontSize: 18,
    color: "#64748b",
    lineHeight: 28,
    textAlign: "center",
    maxWidth: 760,
    marginBottom: 26,
  },

  statsRow: {
    flexDirection: "row",
    gap: 16,
  },

  statCard: {
    backgroundColor: "#ffffff",
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 22,
    minWidth: 180,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    alignItems: "center",
  },

  statIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },

  statValue: {
    fontSize: 24,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 4,
    textAlign: "center",
  },

  statValueSmall: {
    fontSize: 18,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 4,
    textAlign: "center",
  },

  statLabel: {
    fontSize: 14,
    color: "#64748b",
  },

  warn: {
    backgroundColor: "#fef3c7",
    color: "#92400e",
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    fontSize: 14,
    lineHeight: 20,
  },

  grid: {
    flexDirection: "row",
    gap: 24,
    alignItems: "flex-start",
  },

  leftCol: {
    flex: 1,
  },

  rightCol: {
    flex: 1.05,
  },

  panel: {
    backgroundColor: "#ffffff",
    borderRadius: 28,
    padding: 28,
    marginBottom: 20,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },

  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 22,
  },

  panelIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitle: {
    fontSize: 25,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#111827",
  },

  pillsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  input: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d1d5db",
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
  },

  textarea: {
    minHeight: 140,
    textAlignVertical: "top",
    marginBottom: 14,
  },

  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 6,
    shadowColor: "#2563eb",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },

  primaryBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 16,
  },

  secondaryBtn: {
    backgroundColor: "#e5e7eb",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
  },

  secondaryBtnText: {
    color: "#111827",
    fontWeight: "700",
    fontSize: 15,
  },

  buttonDisabled: {
    opacity: 0.7,
  },
});
