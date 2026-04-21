import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Redirect, router, useFocusEffect } from "expo-router";

import {
  clearCoachUser,
  deleteSession,
  getCompletedSessions,
  getSessionReport,
  persistCoachWebSession,
  readCoachUser,
  startSession,
  type SessionListItem,
} from "../services/api";

function formatDate(timestamp?: number) {
  if (!timestamp) return "Unknown date";

  try {
    return new Date(timestamp * 1000).toLocaleString([], {
      month: "numeric",
      day: "numeric",
      year: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(timestamp);
  }
}

function formatDuration(item: SessionListItem) {
  if (item.speech_summary?.duration_label) {
    return String(item.speech_summary.duration_label);
  }

  if (typeof item.speech_summary?.duration_seconds === "number") {
    const seconds = item.speech_summary.duration_seconds;
    if (seconds < 60) return `${seconds}s`;
    return `${Math.round(seconds / 60)} min`;
  }

  return "Session";
}

function getGradePalette(letter?: string) {
  if (!letter) {
    return {
      badge: "#E5E7EB",
      badgeText: "#4B5563",
      progressStart: "#60A5FA",
      progressEnd: "#22D3EE",
    };
  }

  if (letter.startsWith("A")) {
    return {
      badge: "#DCFCE7",
      badgeText: "#15803D",
      progressStart: "#22C55E",
      progressEnd: "#16A34A",
    };
  }

  if (letter.startsWith("B")) {
    return {
      badge: "#DBEAFE",
      badgeText: "#2563EB",
      progressStart: "#3B82F6",
      progressEnd: "#06B6D4",
    };
  }

  if (letter.startsWith("C")) {
    return {
      badge: "#FEF3C7",
      badgeText: "#B45309",
      progressStart: "#F59E0B",
      progressEnd: "#EAB308",
    };
  }

  if (letter.startsWith("D")) {
    return {
      badge: "#FED7AA",
      badgeText: "#C2410C",
      progressStart: "#F97316",
      progressEnd: "#FB923C",
    };
  }

  return {
    badge: "#FEE2E2",
    badgeText: "#DC2626",
    progressStart: "#EF4444",
    progressEnd: "#F97316",
  };
}

export default function HomeScreen() {
  const [username, setUsername] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [expectedText, setExpectedText] = useState("");
  const [keyPointsText, setKeyPointsText] = useState("");
  const [starting, setStarting] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SessionListItem[]>([]);
  const [authChecked, setAuthChecked] = useState(false);

  const parsedKeyPoints = useMemo(() => {
    return keyPointsText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, [keyPointsText]);

  const averageGrade = useMemo(() => {
    const gradedSessions = savedSessions.filter((item) => item.session_grade?.letter);
    if (gradedSessions.length === 0) return "--";

    const totalScore = gradedSessions.reduce(
      (sum, item) => sum + (item.session_grade?.score ?? 0),
      0
    );
    const averageScore = totalScore / gradedSessions.length;

    if (averageScore >= 93) return "A";
    if (averageScore >= 90) return "A-";
    if (averageScore >= 87) return "B+";
    if (averageScore >= 83) return "B";
    if (averageScore >= 80) return "B-";
    if (averageScore >= 77) return "C+";
    if (averageScore >= 73) return "C";
    if (averageScore >= 70) return "C-";
    if (averageScore >= 67) return "D+";
    if (averageScore >= 63) return "D";
    if (averageScore >= 60) return "D-";
    return "F";
  }, [savedSessions]);

  useEffect(() => {
    const user = readCoachUser();

    if (user?.username) {
      setUsername(user.username);
    }

    setAuthChecked(true);
  }, []);

  const loadCompletedSessions = useCallback(async () => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        setSavedSessions([]);
        return;
      }

      setLoadingSessions(true);
      const sessions = await getCompletedSessions(user.username);
      setSavedSessions(sessions || []);
    } catch (err: any) {
      console.log("Failed to load sessions:", err?.response?.data || err?.message || err);
      setSavedSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    loadCompletedSessions();
  }, [loadCompletedSessions]);

  useFocusEffect(
    useCallback(() => {
      loadCompletedSessions();
    }, [loadCompletedSessions])
  );

  const handleStartSession = async () => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      setStarting(true);

      const res = await startSession({
        username: user.username,
        title: sessionTitle,
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

  const handleOpenOldSession = async (item: SessionListItem) => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      const report = await getSessionReport(item.session_id, user.username);

      router.push({
        pathname: "/summary",
        params: {
          data: JSON.stringify(report),
        },
      });
    } catch (err: any) {
      Alert.alert(
        "Open Report Error",
        err?.response?.data?.detail || err?.message || "Could not open session report"
      );
    }
  };

  const handleDeleteSession = async (item: SessionListItem) => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      await deleteSession(item.session_id, user.username);

      setSavedSessions((prev) =>
        prev.filter((session) => session.session_id !== item.session_id)
      );
    } catch (err: any) {
      Alert.alert(
        "Delete Error",
        err?.response?.data?.detail || err?.message || "Could not delete session"
      );
    }
  };

  const handleLogout = () => {
    clearCoachUser();
    router.replace("/login");
  };

  if (!authChecked) {
    return null;
  }

  if (!username) {
    return <Redirect href="/login" />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandIcon}>
              <MaterialCommunityIcons name="microphone" size={22} color="#FFFFFF" />
            </View>
            <Text style={styles.brandText}>SpeakEZ</Text>
          </View>

          <View style={styles.headerActions}>
            <Text style={styles.usernameText}>{username}</Text>
            <TouchableOpacity style={styles.secondaryHeaderButton}>
              <Text style={styles.secondaryHeaderButtonText}>Help</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryHeaderButton} onPress={handleLogout}>
              <Text style={styles.primaryHeaderButtonText}>Logout</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.heroSection}>
          <View style={styles.badge}>
            <MaterialCommunityIcons
              name="star-four-points-outline"
              size={16}
              color="#2563EB"
            />
            <Text style={styles.badgeText}>AI-Powered Speech Coaching</Text>
          </View>

          <Text style={styles.heroTitle}>Practice Smarter. Speak Better.</Text>
          <Text style={styles.heroSubtitle}>
            Get real-time feedback on delivery, body language, emotion, and
            content with your speaking coach.
          </Text>

          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <View style={[styles.statIconWrap, { backgroundColor: "#DBEAFE" }]}>
                <MaterialCommunityIcons name="chart-box" size={24} color="#2563EB" />
              </View>
              <Text style={styles.statValue}>{savedSessions.length}</Text>
              <Text style={styles.statLabel}>Total Sessions</Text>
            </View>

            <View style={styles.statCard}>
              <View style={[styles.statIconWrap, { backgroundColor: "#CFFAFE" }]}>
                <MaterialCommunityIcons name="trophy-outline" size={24} color="#0891B2" />
              </View>
              <Text style={styles.statValue}>{averageGrade}</Text>
              <Text style={styles.statLabel}>Average Grade</Text>
            </View>
          </View>
        </View>

        <View style={styles.mainGrid}>
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View style={[styles.panelIconWrap, { backgroundColor: "#2563EB" }]}>
                <MaterialCommunityIcons name="play" size={24} color="#FFFFFF" />
              </View>
              <Text style={styles.panelTitle}>Start a New Session</Text>
            </View>

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Session Title</Text>
              <TextInput
                style={styles.input}
                placeholder="Give your session a name..."
                placeholderTextColor="#94A3B8"
                value={sessionTitle}
                onChangeText={setSessionTitle}
              />
            </View>

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Speech / expected content...</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Paste or type your speech content here..."
                placeholderTextColor="#94A3B8"
                value={expectedText}
                onChangeText={setExpectedText}
                multiline
                textAlignVertical="top"
              />
            </View>

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Key points (comma separated)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., confidence, clarity, pacing..."
                placeholderTextColor="#94A3B8"
                value={keyPointsText}
                onChangeText={setKeyPointsText}
              />
            </View>

            <TouchableOpacity
              style={[styles.startButton, starting && styles.buttonDisabled]}
              onPress={handleStartSession}
              disabled={starting}
            >
              <MaterialCommunityIcons name="play" size={20} color="#FFFFFF" />
              <Text style={styles.startButtonText}>
                {starting ? "Starting..." : "Start Session"}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View style={[styles.panelIconWrap, { backgroundColor: "#0891B2" }]}>
                <MaterialCommunityIcons name="clock-outline" size={24} color="#FFFFFF" />
              </View>
              <Text style={styles.panelTitle}>Previous Sessions</Text>
            </View>

            {loadingSessions ? (
              <Text style={styles.emptyState}>Loading...</Text>
            ) : savedSessions.length === 0 ? (
              <Text style={styles.emptyState}>No sessions yet.</Text>
            ) : (
              <View style={styles.sessionsList}>
                {savedSessions.map((item) => {
                  const grade = item.session_grade?.letter || "--";
                  const score = item.session_grade?.score ?? 0;
                  const palette = getGradePalette(item.session_grade?.letter);

                  return (
                    <Pressable
                      key={item.session_id}
                      style={styles.sessionCard}
                      onPress={() => handleOpenOldSession(item)}
                    >
                      <View style={styles.sessionTopRow}>
                        <View style={styles.sessionTitleBlock}>
                          <Text style={styles.sessionTitle}>
                            {item.title || "Untitled Session"}
                          </Text>
                          <View style={styles.sessionMetaRow}>
                            <MaterialCommunityIcons
                              name="calendar-month-outline"
                              size={14}
                              color="#64748B"
                            />
                            <Text style={styles.sessionMetaText}>
                              {formatDate(item.created_at)}
                            </Text>
                            <Text style={styles.sessionMetaDot}>•</Text>
                            <Text style={styles.sessionMetaText}>{formatDuration(item)}</Text>
                          </View>
                        </View>

                        <TouchableOpacity
                          style={styles.deleteButton}
                          onPress={() => handleDeleteSession(item)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <MaterialCommunityIcons
                            name="trash-can-outline"
                            size={18}
                            color="#EF4444"
                          />
                        </TouchableOpacity>
                      </View>

                      <View style={styles.sessionBottomRow}>
                        <View
                          style={[
                            styles.gradeBadge,
                            { backgroundColor: palette.badge },
                          ]}
                        >
                          <Text
                            style={[
                              styles.gradeBadgeText,
                              { color: palette.badgeText },
                            ]}
                          >
                            {grade}
                          </Text>
                        </View>

                        <View style={styles.progressTrack}>
                          <View
                            style={[
                              styles.progressFill,
                              {
                                width: `${Math.max(0, Math.min(score, 100))}%`,
                                backgroundColor: palette.progressStart,
                              },
                            ]}
                          />
                          <View
                            style={[
                              styles.progressAccent,
                              { backgroundColor: palette.progressEnd },
                            ]}
                          />
                        </View>

                        <Text style={styles.scoreText}>{score}/100</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </View>

        <View style={styles.whySection}>
          <Text style={styles.whyTitle}>Why SpeakEZ?</Text>

          <View style={styles.featureGrid}>
            <View style={styles.featureItem}>
              <View style={styles.featureIconWrap}>
                <MaterialCommunityIcons name="trending-up" size={30} color="#FFFFFF" />
              </View>
              <Text style={styles.featureTitle}>Instant Analysis</Text>
              <Text style={styles.featureText}>
                Get real-time speech, vocal, and body language analysis as you
                practice.
              </Text>
            </View>

            <View style={styles.featureItem}>
              <View style={styles.featureIconWrap}>
                <MaterialCommunityIcons name="target" size={30} color="#FFFFFF" />
              </View>
              <Text style={styles.featureTitle}>Personalized Feedback</Text>
              <Text style={styles.featureText}>
                Receive suggestions tuned to your speaking patterns and goals.
              </Text>
            </View>

            <View style={styles.featureItem}>
              <View style={styles.featureIconWrap}>
                <MaterialCommunityIcons
                  name="star-four-points-outline"
                  size={30}
                  color="#FFFFFF"
                />
              </View>
              <Text style={styles.featureTitle}>Track Progress</Text>
              <Text style={styles.featureText}>
                See improvement over time with saved sessions and grade trends.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#EFF6FF",
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },
  header: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brandIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },
  brandText: {
    fontSize: 28,
    fontWeight: "800",
    color: "#1D4ED8",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  usernameText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#475569",
    marginRight: 2,
  },
  secondaryHeaderButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  secondaryHeaderButtonText: {
    color: "#475569",
    fontWeight: "600",
  },
  primaryHeaderButton: {
    backgroundColor: "#2563EB",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryHeaderButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 28,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#DBEAFE",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginBottom: 18,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1D4ED8",
  },
  heroTitle: {
    fontSize: 38,
    lineHeight: 44,
    fontWeight: "800",
    color: "#0F172A",
    textAlign: "center",
    marginBottom: 12,
    maxWidth: 640,
  },
  heroSubtitle: {
    fontSize: 17,
    lineHeight: 26,
    color: "#475569",
    textAlign: "center",
    maxWidth: 640,
    marginBottom: 24,
  },
  statsGrid: {
    width: "100%",
    maxWidth: 420,
    flexDirection: "row",
    gap: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    paddingVertical: 22,
    paddingHorizontal: 18,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
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
    fontSize: 32,
    fontWeight: "800",
    color: "#0F172A",
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 14,
    color: "#64748B",
    textAlign: "center",
  },
  mainGrid: {
    gap: 18,
    marginBottom: 28,
  },
  panel: {
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
  },
  panelIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitle: {
    flex: 1,
    fontSize: 26,
    fontWeight: "800",
    color: "#0F172A",
  },
  fieldBlock: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#334155",
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: "#0F172A",
    backgroundColor: "#FFFFFF",
  },
  textarea: {
    minHeight: 120,
  },
  startButton: {
    backgroundColor: "#2563EB",
    borderRadius: 14,
    paddingVertical: 16,
    justifyContent: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  startButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 16,
  },
  emptyState: {
    fontSize: 15,
    color: "#64748B",
  },
  sessionsList: {
    gap: 14,
  },
  sessionCard: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 18,
    padding: 18,
    backgroundColor: "#FFFFFF",
  },
  sessionTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
  },
  sessionTitleBlock: {
    flex: 1,
  },
  sessionTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#0F172A",
    marginBottom: 6,
  },
  sessionMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  sessionMetaText: {
    fontSize: 13,
    color: "#64748B",
  },
  sessionMetaDot: {
    color: "#94A3B8",
  },
  deleteButton: {
    padding: 6,
    borderRadius: 8,
  },
  sessionBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  gradeBadge: {
    minWidth: 54,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    alignItems: "center",
  },
  gradeBadgeText: {
    fontSize: 13,
    fontWeight: "800",
  },
  progressTrack: {
    flex: 1,
    height: 10,
    backgroundColor: "#E2E8F0",
    borderRadius: 999,
    overflow: "hidden",
    position: "relative",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  progressAccent: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 10,
    opacity: 0.9,
  },
  scoreText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#334155",
    minWidth: 52,
    textAlign: "right",
  },
  whySection: {
    backgroundColor: "#0EA5E9",
    borderRadius: 24,
    paddingVertical: 28,
    paddingHorizontal: 22,
  },
  whyTitle: {
    fontSize: 30,
    fontWeight: "800",
    color: "#FFFFFF",
    textAlign: "center",
    marginBottom: 22,
  },
  featureGrid: {
    gap: 22,
  },
  featureItem: {
    alignItems: "center",
  },
  featureIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  featureTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
    marginBottom: 8,
    textAlign: "center",
  },
  featureText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#E0F2FE",
    textAlign: "center",
  },
});
