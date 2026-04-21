import React, { useMemo } from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
  Platform,
  Alert,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";
import FeedbackCard from "../components/FeedbackCard";
import AppHeader from "../components/AppHeader";
import Ionicons from "@expo/vector-icons/Ionicons";

function getGradePillStyle(letter?: string) {
  if (!letter) return { bg: "#e5e7eb", text: "#475569" };
  if (letter.startsWith("A")) return { bg: "#dcfce7", text: "#15803d" };
  if (letter.startsWith("B")) return { bg: "#dbeafe", text: "#2563eb" };
  if (letter.startsWith("C")) return { bg: "#fef3c7", text: "#b45309" };
  if (letter.startsWith("D")) return { bg: "#fed7aa", text: "#c2410c" };
  return { bg: "#fee2e2", text: "#b91c1c" };
}

export default function SummaryScreen() {
  const params = useLocalSearchParams<{ data?: string }>();

  const summary = useMemo(() => {
    try {
      return JSON.parse(String(params.data || "{}"));
    } catch {
      return {};
    }
  }, [params.data]);

  const overallFeedback: string[] = summary?.overall_feedback || [];
  const speechSummary = summary?.speech_summary || {};
  const emotionSummary = summary?.emotion_summary || {};
  const bodySummary = summary?.body_summary || {};
  const contentSummary = summary?.content_summary || {};
  const medians = speechSummary?.medians || {};
  const sessionGrade = summary?.session_grade || {};
  const gradeLetter = sessionGrade?.letter;
  const gradeScore = sessionGrade?.score;
  const gradePill = getGradePillStyle(gradeLetter);

  const speechHeadline =
    speechSummary?.next_step ||
    speechSummary?.areas_to_improve?.[0] ||
    speechSummary?.what_went_well?.[0] ||
    "No speech summary yet.";

  const buildSummaryText = () => {
    return `
AI Public Speaking Coach - Session Summary

Date: ${new Date().toLocaleString()}

Overall Feedback:
${overallFeedback.length ? overallFeedback.join("\n") : "No feedback"}

Speech Metrics:
- WPM: ${medians?.estimated_wpm ?? "N/A"}
- Volume: ${medians?.avg_dbfs ?? "N/A"}
- SNR: ${medians?.snr_db ?? "N/A"}
- Pitch Range: ${medians?.pitch_range_hz ?? "N/A"}
- Silence: ${medians?.silence_pct ?? "N/A"}%

Emotion:
${emotionSummary?.dominant_emotion ?? "N/A"}

Body Language:
${bodySummary?.top_feedback?.join("\n") ?? "N/A"}

Content:
${contentSummary?.topic_status ?? "N/A"}

Next Step:
${speechSummary?.next_step ?? "Keep practicing"}
`.trim();
  };

  const handleDownloadSummary = () => {
    const text = buildSummaryText();

    if (Platform.OS === "web") {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = `session-summary-${Date.now()}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);
    } else {
      Alert.alert("Download only works on web for now");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <AppHeader title="" />

        <View style={styles.hero}>
          <View style={styles.heroTag}>
            <Text style={styles.heroTagText}>Session Summary</Text>
          </View>

          <Text style={styles.heroTitle}>Review. Reflect. Improve.</Text>

          <Text style={styles.heroSubtitle}>
            Review your session results, understand your strengths, and focus on
            the areas that will improve your next performance.
          </Text>

          {gradeLetter ? (
            <View style={styles.gradeHeroCard}>
              <View
                style={[
                  styles.gradeHeroPill,
                  { backgroundColor: gradePill.bg },
                ]}
              >
                <Text
                  style={[
                    styles.gradeHeroPillText,
                    { color: gradePill.text },
                  ]}
                >
                  {gradeLetter}
                </Text>
              </View>

              <View style={styles.gradeHeroInfo}>
                <Text style={styles.gradeHeroScore}>{gradeScore}/100</Text>
                <Text style={styles.gradeHeroLabel}>Overall Session Grade</Text>
                {sessionGrade?.summary ? (
                  <Text style={styles.gradeHeroSummary}>
                    {sessionGrade.summary}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.floatingDownload,
              pressed && styles.floatingDownloadPressed,
            ]}
            onPress={handleDownloadSummary}
          >
            <Ionicons name="download-outline" size={24} color="#1e40af" />
          </Pressable>
        </View>

        <View style={styles.grid}>
          <View style={styles.leftCol}>
            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#dbeafe" }]}>
                <Feather name="message-circle" size={18} color="#1e3a8a" />
                </View>
                <Text style={styles.panelTitle}>Core Feedback</Text>
              </View>

              <FeedbackCard
                title="Speech Delivery"
                value={speechHeadline}
                subtitle={
                  medians?.estimated_wpm !== undefined
                    ? `Median pace: ${medians.estimated_wpm} WPM`
                    : undefined
                }
              />

              <FeedbackCard
                title="Facial Emotion"
                value={emotionSummary?.dominant_emotion || "No emotion summary yet"}
              />

              <FeedbackCard
                title="Body Language"
                value={bodySummary?.top_feedback?.[0] || "No body summary yet"}
              />

              <FeedbackCard
                title="Content Relevance"
                value={contentSummary?.topic_status || "No content summary yet"}
                subtitle={
                  contentSummary?.similarity_score !== undefined
                    ? `Similarity score: ${contentSummary.similarity_score}`
                    : undefined
                }
              />
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#dcfce7" }]}>
                  <Feather name="check-circle" size={18} color="#15803d" />
                </View>
                <Text style={styles.panelTitle}>What Went Well</Text>
              </View>

              {speechSummary?.what_went_well?.length ? (
                speechSummary.what_went_well.map((item: string, index: number) => (
                  <Text key={`${item}-${index}`} style={styles.feedbackItem}>
                    • {item}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>No strengths recorded yet.</Text>
              )}
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#fee2e2" }]}>
                  <Feather name="trending-up" size={18} color="#b91c1c" />
                </View>
                <Text style={styles.panelTitle}>Areas to Improve</Text>
              </View>

              {speechSummary?.areas_to_improve?.length ? (
                speechSummary.areas_to_improve.map((item: string, index: number) => (
                  <Text key={`${item}-${index}`} style={styles.feedbackItem}>
                    • {item}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>
                  No major improvement areas recorded yet.
                </Text>
              )}
            </View>
          </View>

          <View style={styles.rightCol}>
            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#cffafe" }]}>
                  <Feather name="bar-chart-2" size={18} color="#0f766e" />
                </View>
                <Text style={styles.panelTitle}>Speech Metrics</Text>
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Median WPM</Text>
                <Text style={styles.metricValue}>
                  {medians?.estimated_wpm ?? "N/A"}
                </Text>
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Median Volume</Text>
                <Text style={styles.metricValue}>
                  {medians?.avg_dbfs ?? "N/A"} dBFS
                </Text>
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Median SNR</Text>
                <Text style={styles.metricValue}>
                  {medians?.snr_db ?? "N/A"} dB
                </Text>
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Median Pitch Range</Text>
                <Text style={styles.metricValue}>
                  {medians?.pitch_range_hz ?? "N/A"} Hz
                </Text>
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Median Silence</Text>
                <Text style={styles.metricValue}>
                  {medians?.silence_pct ?? "N/A"}%
                </Text>
              </View>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#ede9fe" }]}>
                  <Feather name="file-text" size={18} color="#6d28d9" />
                </View>
                <Text style={styles.panelTitle}>Overall Feedback</Text>
              </View>

              {overallFeedback.length ? (
                overallFeedback.map((item: string, index: number) => (
                  <Text key={`${item}-${index}`} style={styles.feedbackItem}>
                    • {item}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>No overall feedback yet.</Text>
              )}
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#fef3c7" }]}>
                  <Feather name="arrow-right" size={18} color="#92400e" />
                </View>
                <Text style={styles.panelTitle}>Next Step</Text>
              </View>

              <Text style={styles.nextStepText}>
                {speechSummary?.next_step ||
                  "Keep practicing with steady pace and clear delivery."}
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
    backgroundColor: "#eef4ff",
  },

  container: {
    padding: 24,
    paddingBottom: 48,
  },

  navbar: {
    backgroundColor: "rgba(255,255,255,0.88)",
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 18,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },

  hero: {
    position: "relative",
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
    paddingBottom: 88,
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
    marginBottom: 24,
  },

  gradeHeroCard: {
    backgroundColor: "#f8fbff",
    borderRadius: 24,
    paddingVertical: 20,
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#dbeafe",
    minWidth: 340,
    maxWidth: 560,
  },

  gradeHeroPill: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 18,
    minWidth: 90,
    alignItems: "center",
    marginRight: 18,
  },

  gradeHeroPillText: {
    fontSize: 32,
    fontWeight: "800",
  },

  gradeHeroInfo: {
    flex: 1,
  },

  gradeHeroScore: {
    fontSize: 24,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#111827",
    marginBottom: 4,
  },

  gradeHeroLabel: {
    fontSize: 14,
    color: "#64748b",
    marginBottom: 6,
  },

  gradeHeroSummary: {
    fontSize: 14,
    lineHeight: 22,
    color: "#475569",
  },

  floatingDownload: {
    position: "absolute",
    right: 24,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#e0ecff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#2563eb",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },

  floatingDownloadPressed: {
    transform: [{ scale: 0.94 }],
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
    flex: 1,
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

  panelIconText: {
    fontSize: 19,
    fontWeight: "700",
  },

  panelTitle: {
    fontSize: 25,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#111827",
  },

  feedbackItem: {
    fontSize: 15,
    color: "#374151",
    marginBottom: 10,
    lineHeight: 24,
  },

  emptyText: {
    fontSize: 14,
    color: "#6b7280",
  },

  metricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },

  metricLabel: {
    fontSize: 14,
    color: "#475569",
    fontWeight: "600",
  },

  metricValue: {
    fontSize: 15,
    color: "#111827",
    fontWeight: "700",
  },

  nextStepText: {
    fontSize: 15,
    lineHeight: 24,
    color: "#374151",
  },
});
