import React, { useEffect, useMemo, useState } from "react";
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
import { router } from "expo-router";
import { Platform } from "react-native";

import {
  persistCoachWebSession,
  startSession,
} from "../services/api";

const HISTORY_STORAGE_KEY = "capstoneCoachSessionHistory_v1";

type SavedSession = {
  sessionId: string;
  createdAt: string;
  expectedText: string;
  keyPoints: string[];
};

function readSavedSessions(): SavedSession[] {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedSessions(items: SavedSession[]) {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage errors
  }
}

function saveSessionToHistory(item: SavedSession) {
  const existing = readSavedSessions();

  const deduped = existing.filter((s) => s.sessionId !== item.sessionId);
  const next = [item, ...deduped].slice(0, 20);

  writeSavedSessions(next);
}

function formatDate(dateString: string) {
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}

export default function HomeScreen() {
  const [expectedText, setExpectedText] = useState("");
  const [keyPointsText, setKeyPointsText] = useState("");
  const [starting, setStarting] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);

  useEffect(() => {
    setSavedSessions(readSavedSessions());
  }, []);

  const parsedKeyPoints = useMemo(() => {
    return keyPointsText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, [keyPointsText]);

  const handleStartSession = async () => {
    try {
      setStarting(true);

      const res = await startSession({
        expected_text: expectedText.trim(),
        key_points: parsedKeyPoints,
      });

      const sessionId = String(res?.session_id || "");
      if (!sessionId) {
        throw new Error("No session ID returned from backend.");
      }

      persistCoachWebSession({
        sessionId,
        expectedText: expectedText.trim(),
        keyPoints: parsedKeyPoints,
      });

      const historyItem: SavedSession = {
        sessionId,
        createdAt: new Date().toISOString(),
        expectedText: expectedText.trim(),
        keyPoints: parsedKeyPoints,
      };

      saveSessionToHistory(historyItem);
      setSavedSessions(readSavedSessions());

      router.push({
        pathname: "/live-session",
        params: {
          sessionId,
          expectedText: expectedText.trim(),
          keyPoints: JSON.stringify(parsedKeyPoints),
        },
      });
    } catch (err: any) {
      Alert.alert(
        "Start Session Error",
        err?.response?.data?.detail || err?.message || "Could not start session"
      );
    } finally {
      setStarting(false);
    }
  };

  const handleOpenOldSession = (item: SavedSession) => {
    persistCoachWebSession({
      sessionId: item.sessionId,
      expectedText: item.expectedText,
      keyPoints: item.keyPoints,
    });

    router.push({
      pathname: "/live-session",
      params: {
        sessionId: item.sessionId,
        expectedText: item.expectedText,
        keyPoints: JSON.stringify(item.keyPoints),
      },
    });
  };

  const handleDeleteSavedSession = (sessionId: string) => {
    const next = savedSessions.filter((s) => s.sessionId !== sessionId);
    setSavedSessions(next);
    writeSavedSessions(next);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.heroCard}>
          <Text style={styles.title}>AI Public Speaking Coach</Text>
          <Text style={styles.subtitle}>
            Practice your speech with live multimodal feedback on delivery,
            body language, emotion, and content alignment.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Start a New Practice Session</Text>

          <Text style={styles.label}>Planned Speech / Expected Content</Text>
          <TextInput
            style={[styles.input, styles.largeInput]}
            placeholder="Paste your speech outline or the text you want to be checked against..."
            value={expectedText}
            onChangeText={setExpectedText}
            multiline
          />

          <Text style={styles.label}>Key Points</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter comma-separated key points, e.g. confidence, posture, eye contact"
            value={keyPointsText}
            onChangeText={setKeyPointsText}
          />

          <TouchableOpacity
            style={[styles.primaryBtn, starting && { opacity: 0.7 }]}
            onPress={handleStartSession}
            disabled={starting}
          >
            <Text style={styles.primaryBtnText}>
              {starting ? "Starting..." : "Start Practice Session"}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Why This Program Is Useful</Text>

          <View style={styles.bulletBlock}>
            <Text style={styles.bulletTitle}>Real-time delivery coaching</Text>
            <Text style={styles.bulletText}>
              The program gives live feedback while you speak, so you can catch
              issues with pace, pauses, vocal variety, and volume in the moment.
            </Text>
          </View>

          <View style={styles.bulletBlock}>
            <Text style={styles.bulletTitle}>Multimodal speaking analysis</Text>
            <Text style={styles.bulletText}>
              It does more than just speech analysis. It also looks at body
              language and facial expression, which makes the practice feel more
              like real coaching.
            </Text>
          </View>

          <View style={styles.bulletBlock}>
            <Text style={styles.bulletTitle}>Content checking against your plan</Text>
            <Text style={styles.bulletText}>
              You can compare what you actually said against your expected
              speech and key points, which helps you stay organized and on topic.
            </Text>
          </View>

          <View style={styles.bulletBlock}>
            <Text style={styles.bulletTitle}>Helpful for repeated practice</Text>
            <Text style={styles.bulletText}>
              Since sessions are saved, you can revisit your previous practice
              attempts and track how your speaking improves over time.
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Previous Sessions</Text>

          {savedSessions.length === 0 ? (
            <Text style={styles.emptyText}>
              No saved sessions yet. Start one above to see it here.
            </Text>
          ) : (
            savedSessions.map((item) => (
              <View key={item.sessionId} style={styles.sessionRow}>
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionIdText}>{item.sessionId}</Text>
                  <Text style={styles.sessionMeta}>
                    {formatDate(item.createdAt)}
                  </Text>
                  <Text style={styles.sessionPreview} numberOfLines={2}>
                    {item.expectedText || "No expected text provided"}
                  </Text>
                  {item.keyPoints.length > 0 ? (
                    <Text style={styles.sessionMeta}>
                      Key points: {item.keyPoints.join(", ")}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.sessionActions}>
                  <TouchableOpacity
                    style={styles.smallPrimaryBtn}
                    onPress={() => handleOpenOldSession(item)}
                  >
                    <Text style={styles.smallPrimaryBtnText}>Open</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.smallDeleteBtn}
                    onPress={() => handleDeleteSavedSession(item.sessionId)}
                  >
                    <Text style={styles.smallDeleteBtnText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </View>
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
  heroCard: {
    backgroundColor: "#ffffff",
    borderRadius: 24,
    padding: 22,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: "#4b5563",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 14,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
    marginTop: 4,
  },
  input: {
    backgroundColor: "#f3f4f6",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  largeInput: {
    minHeight: 140,
    textAlignVertical: "top",
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
  },
  primaryBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 16,
  },
  bulletBlock: {
    marginBottom: 14,
  },
  bulletTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  bulletText: {
    fontSize: 14,
    lineHeight: 21,
    color: "#4b5563",
  },
  emptyText: {
    fontSize: 14,
    color: "#6b7280",
  },
  sessionRow: {
    backgroundColor: "#f9fafb",
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  sessionInfo: {
    marginBottom: 10,
  },
  sessionIdText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  sessionMeta: {
    fontSize: 12,
    color: "#6b7280",
    marginBottom: 4,
  },
  sessionPreview: {
    fontSize: 14,
    color: "#374151",
    marginBottom: 4,
  },
  sessionActions: {
    flexDirection: "row",
    gap: 10,
  },
  smallPrimaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  smallPrimaryBtnText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  smallDeleteBtn: {
    backgroundColor: "#e5e7eb",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  smallDeleteBtnText: {
    color: "#111827",
    fontWeight: "700",
  },
});