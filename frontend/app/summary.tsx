import React, { useMemo } from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import FeedbackCard from "../components/FeedbackCard";
import AppHeader from "../components/AppHeader";

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

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.navbar}>
          <AppHeader title="" />
        </View>

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
        </View>

        <View style={styles.grid}>
          <View style={styles.leftCol}>
            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.panelIcon, { backgroundColor: "#dbeafe" }]}>
                  <Text style={styles.panelIconText}>🗣</Text>
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
                  <Text style={styles.panelIconText}>✅</Text>
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
                  <Text style={styles.panelIconText}>📈</Text>
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
                  <Text style={styles.panelIconText}>📊</Text>
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
                  <Text style={styles.panelIconText}>📝</Text>
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
                  <Text style={styles.panelIconText}>➡</Text>
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