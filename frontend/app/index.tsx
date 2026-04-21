import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
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

function averageFromSessions(
  sessions: SessionListItem[],
  selector: (item: SessionListItem) => number | undefined
) {
  const values = sessions
    .map((item) => selector(item))
    .filter((value): value is number => typeof value === "number" && !Number.isNaN(value));

  if (values.length === 0) {
    return 0;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export default function HomeScreen() {
  const [username, setUsername] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [expectedText, setExpectedText] = useState("");
  const [keyPointsText, setKeyPointsText] = useState("");
  const [starting, setStarting] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SessionListItem[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
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

  const performanceMetrics = useMemo(() => {
    const totalAttempts = savedSessions.reduce(
      (sum, item) => sum + (item.attempt_count ?? item.attempts?.length ?? 0),
      0
    );
    const averageScore = averageFromSessions(
      savedSessions,
      (item) =>
        item.session_grade?.score ??
        ((item as SessionListItem & { overall_score?: number }).overall_score)
    );
    const bestSession = savedSessions.reduce<SessionListItem | null>((best, item) => {
      if (!best) return item;
      const itemScore =
        item.session_grade?.score ??
        ((item as SessionListItem & { overall_score?: number }).overall_score ?? 0);
      const bestScore =
        best.session_grade?.score ??
        ((best as SessionListItem & { overall_score?: number }).overall_score ?? 0);
      return itemScore > bestScore
        ? item
        : best;
    }, null);
    const latestSession = savedSessions[0];

    return {
      totalAttempts,
      averageScore,
      bestTitle: bestSession?.title || "No sessions yet",
      bestGrade: bestSession?.session_grade?.letter || "--",
      latestPractice: latestSession?.created_at
        ? formatDate(latestSession.created_at)
        : "No recent practice",
      speechAverage: averageFromSessions(
        savedSessions,
        (item) => item.session_grade?.breakdown?.speech ?? item.speech_summary?.overall_score
      ),
      contentAverage: averageFromSessions(
        savedSessions,
        (item) => item.session_grade?.breakdown?.content ?? item.content_summary?.overall_score
      ),
      bodyAverage: averageFromSessions(
        savedSessions,
        (item) => item.session_grade?.breakdown?.body ?? item.body_summary?.overall_score
      ),
      emotionAverage: averageFromSessions(
        savedSessions,
        (item) => item.session_grade?.breakdown?.emotion ?? item.emotion_summary?.overall_score
      ),
    };
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

      const report = await getSessionReport(
        item.latest_attempt_id || item.session_id,
        user.username
      );

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

  const handleOpenAttempt = async (attemptId: string) => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      const report = await getSessionReport(attemptId, user.username);

      router.push({
        pathname: "/summary",
        params: {
          data: JSON.stringify(report),
        },
      });
    } catch (err: any) {
      Alert.alert(
        "Open Attempt Error",
        err?.response?.data?.detail || err?.message || "Could not open attempt details"
      );
    }
  };

  const handleStartNewAttempt = async (item: SessionListItem) => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      setStarting(true);

      const res = await startSession({
        username: user.username,
        title: item.title,
        session_group_id: item.session_group_id || item.session_id,
        expected_text: item.expected_text,
        key_points: item.key_points,
      });

      const sessionId = String(res?.session_id || "");
      if (!sessionId) {
        throw new Error("No session ID returned from backend.");
      }

      persistCoachWebSession({
        sessionId,
        title: item.title,
        expectedText: item.expected_text,
        keyPoints: item.key_points,
      });

      router.push({
        pathname: "/live-session",
        params: {
          sessionId,
          expectedText: item.expected_text,
          keyPoints: JSON.stringify(item.key_points || []),
        },
      });
    } catch (err: any) {
      Alert.alert(
        "New Attempt Error",
        err?.response?.data?.detail || err?.message || "Could not start a new attempt"
      );
    } finally {
      setStarting(false);
    }
  };

  const toggleAttempts = (sessionId: string) => {
    setExpandedSessions((prev) => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }));
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
            <TouchableOpacity onPress={() => router.replace("/")} activeOpacity={0.85}>
              <Image
                source={require("../assets/images/logo.png")}
                style={styles.brandLogo}
                resizeMode="contain"
              />
            </TouchableOpacity>
          </View>

          <View style={styles.headerActions}>
            <Text style={styles.usernameText}>{username}</Text>
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
              <View style={[styles.panelIconWrap, { backgroundColor: "#CFFAFE" }]}>
                <MaterialCommunityIcons name="chart-line" size={24} color="#0F766E" />
              </View>
              <Text style={styles.panelTitle}>Performance Metrics</Text>
            </View>

            <View style={styles.metricsGrid}>
              <View style={styles.metricCard}>
                <Text style={styles.metricCardValue}>{performanceMetrics.averageScore}</Text>
                <Text style={styles.metricCardLabel}>Average Score</Text>
              </View>

              <View style={styles.metricCard}>
                <Text style={styles.metricCardValue}>{performanceMetrics.totalAttempts}</Text>
                <Text style={styles.metricCardLabel}>Total Attempts</Text>
              </View>
            </View>

            <View style={styles.metricSummaryCard}>
              <Text style={styles.metricSummaryTitle}>Best Session</Text>
              <Text style={styles.metricSummaryValue}>
                {performanceMetrics.bestTitle} • {performanceMetrics.bestGrade}
              </Text>
            </View>

            <View style={styles.metricSummaryCard}>
              <Text style={styles.metricSummaryTitle}>Latest Practice</Text>
              <Text style={styles.metricSummaryValue}>
                {performanceMetrics.latestPractice}
              </Text>
            </View>
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
                  const attempts = item.attempts || [];
                  const attemptCount = item.attempt_count ?? attempts.length;
                  const isExpanded = !!expandedSessions[item.session_id];

                  return (
                    <View key={item.session_id} style={styles.sessionCard}>
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
                            <Text style={styles.sessionMetaText}>
                              {attemptCount} {attemptCount === 1 ? "attempt" : "attempts"}
                            </Text>
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

                      <View style={styles.sessionActionsRow}>
                        <TouchableOpacity
                          style={styles.inlineActionButton}
                          onPress={() => handleOpenOldSession(item)}
                        >
                          <Text style={styles.inlineActionButtonText}>Latest Details</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[styles.inlineActionButton, starting && styles.buttonDisabled]}
                          onPress={() => handleStartNewAttempt(item)}
                          disabled={starting}
                        >
                          <Text style={styles.inlineActionButtonText}>New Attempt</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.inlineActionButton}
                          onPress={() => toggleAttempts(item.session_id)}
                        >
                          <Text style={styles.inlineActionButtonText}>
                            {isExpanded ? "Hide Previous Attempts" : "Previous Attempts"}
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {isExpanded ? (
                        <View style={styles.attemptsDropdown}>
                          {attempts.length === 0 ? (
                            <Text style={styles.emptyAttemptsText}>
                              No saved attempts for this session yet.
                            </Text>
                          ) : (
                            attempts.map((attempt, index) => (
                              <Pressable
                                key={attempt.attempt_id}
                                style={styles.attemptCard}
                                onPress={() => handleOpenAttempt(attempt.attempt_id)}
                              >
                                <View style={styles.attemptHeaderRow}>
                                  <Text style={styles.attemptTitle}>
                                    Attempt {attemptCount - index}
                                  </Text>
                                  <Text style={styles.attemptScore}>
                                    {attempt.session_grade?.letter || "--"} •{" "}
                                    {attempt.session_grade?.score ?? attempt.overall_score ?? 0}/100
                                  </Text>
                                </View>
                                <Text style={styles.attemptDate}>
                                  {formatDate(attempt.created_at)}
                                </Text>
                                <Text style={styles.attemptPreview}>
                                  {attempt.transcript_preview || "No transcript preview available."}
                                </Text>
                              </Pressable>
                            ))
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </View>

        <View style={styles.whySection}>
          <View style={styles.whyHeader}>
            <View style={[styles.panelIconWrap, { backgroundColor: "#DBEAFE" }]}>
              <MaterialCommunityIcons
                name="star-four-points-outline"
                size={24}
                color="#2563EB"
              />
            </View>
            <View style={styles.whyHeaderCopy}>
              <Text style={styles.panelTitle}>Why SpeakEZ</Text>
              <Text style={styles.whySubtitle}>
                A coaching experience built to help you practice with more clarity,
                better feedback, and measurable momentum.
              </Text>
            </View>
          </View>

          <View style={styles.featureGrid}>
            <View style={styles.featureItem}>
              <View style={[styles.featureIconWrap, { backgroundColor: "#DBEAFE" }]}>
                <MaterialCommunityIcons name="chart-line" size={24} color="#2563EB" />
              </View>
              <Text style={styles.featureTitle}>Instant Analysis</Text>
              <Text style={styles.featureText}>
                Real-time speech, vocal, and body-language analysis while you practice.
              </Text>
            </View>

            <View style={styles.featureItem}>
              <View style={[styles.featureIconWrap, { backgroundColor: "#E0F2FE" }]}>
                <MaterialCommunityIcons name="target" size={24} color="#0891B2" />
              </View>
              <Text style={styles.featureTitle}>Personalized Feedback</Text>
              <Text style={styles.featureText}>
                Suggestions shaped around your speaking patterns, habits, and goals.
              </Text>
            </View>

            <View style={styles.featureItem}>
              <View style={[styles.featureIconWrap, { backgroundColor: "#DCFCE7" }]}>
                <MaterialCommunityIcons name="history" size={24} color="#15803D" />
              </View>
              <Text style={styles.featureTitle}>Progress Over Time</Text>
              <Text style={styles.featureText}>
                Review sessions, compare attempts, and see your performance improve.
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
  },
  brandLogo: {
    width: 240,
    height: 84,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  usernameText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#475569",
    marginRight: 2,
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
    fontFamily: "PTSerifBold",
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
    fontFamily: "PTSerifBold",
    color: "#0F172A",
  },
  metricsGrid: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1,
    backgroundColor: "#F8FAFC",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  metricCardValue: {
    fontSize: 28,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 4,
  },
  metricCardLabel: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
  },
  metricSummaryCard: {
    backgroundColor: "#EFF6FF",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
  },
  metricSummaryTitle: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metricSummaryValue: {
    fontSize: 15,
    color: "#0F172A",
    fontWeight: "700",
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
    fontFamily: "PTSerifBold",
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
  sessionActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },
  inlineActionButton: {
    backgroundColor: "#EFF6FF",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inlineActionButtonText: {
    color: "#1D4ED8",
    fontWeight: "700",
    fontSize: 13,
  },
  attemptsDropdown: {
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
    paddingTop: 14,
    gap: 10,
  },
  attemptCard: {
    backgroundColor: "#F8FAFC",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 14,
  },
  attemptHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 4,
  },
  attemptTitle: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "800",
  },
  attemptScore: {
    color: "#1D4ED8",
    fontSize: 13,
    fontWeight: "700",
  },
  attemptDate: {
    color: "#64748B",
    fontSize: 12,
    marginBottom: 8,
  },
  attemptPreview: {
    color: "#334155",
    fontSize: 13,
    lineHeight: 20,
  },
  emptyAttemptsText: {
    color: "#64748B",
    fontSize: 13,
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
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    paddingVertical: 22,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  whyHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 20,
  },
  whyHeaderCopy: {
    flex: 1,
  },
  whySubtitle: {
    fontSize: 15,
    lineHeight: 23,
    color: "#475569",
    marginTop: 6,
  },
  featureGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  featureItem: {
    flex: 1,
    minWidth: 220,
    backgroundColor: "#F8FAFC",
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  featureIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  featureTitle: {
    fontSize: 18,
    fontWeight: "700",
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 8,
  },
  featureText: {
    fontSize: 14,
    lineHeight: 23,
    color: "#475569",
  },
});
