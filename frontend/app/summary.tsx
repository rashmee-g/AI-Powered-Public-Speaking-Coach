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

  const speechHeadline =
    speechSummary?.next_step ||
    speechSummary?.areas_to_improve?.[0] ||
    speechSummary?.what_went_well?.[0] ||
    "No speech summary yet.";

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <AppHeader title="Session Summary" />

        
        <Text style={styles.subtitle}>
          Review your results and focus on your biggest improvement areas.
        </Text>

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

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What Went Well</Text>
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

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Areas to Improve</Text>
          {speechSummary?.areas_to_improve?.length ? (
            speechSummary.areas_to_improve.map((item: string, index: number) => (
              <Text key={`${item}-${index}`} style={styles.feedbackItem}>
                • {item}
              </Text>
            ))
          ) : (
            <Text style={styles.emptyText}>No major improvement areas recorded yet.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Overall Feedback</Text>
          {overallFeedback.length ? (
            overallFeedback.map((item, index) => (
              <Text key={`${item}-${index}`} style={styles.feedbackItem}>
                • {item}
              </Text>
            ))
          ) : (
            <Text style={styles.emptyText}>No overall feedback yet.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Speech Metrics</Text>
          <Text style={styles.metricText}>
            Median WPM: {medians?.estimated_wpm ?? "N/A"}
          </Text>
          <Text style={styles.metricText}>
            Median Volume: {medians?.avg_dbfs ?? "N/A"} dBFS
          </Text>
          <Text style={styles.metricText}>
            Median SNR: {medians?.snr_db ?? "N/A"} dB
          </Text>
          <Text style={styles.metricText}>
            Median Pitch Range: {medians?.pitch_range_hz ?? "N/A"} Hz
          </Text>
          <Text style={styles.metricText}>
            Median Silence: {medians?.silence_pct ?? "N/A"}%
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Next Step</Text>
          <Text style={styles.feedbackItem}>
            {speechSummary?.next_step || "Keep practicing with steady pace and clear delivery."}
          </Text>
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
  title: {
    fontSize: 40,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: "#4b5563",
    marginBottom: 16,
    lineHeight: 22,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 20,
    padding: 18,
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
  feedbackItem: {
    fontSize: 15,
    color: "#374151",
    marginBottom: 8,
    lineHeight: 22,
  },
  emptyText: {
    fontSize: 15,
    color: "#6b7280",
  },
  metricText: {
    fontSize: 15,
    color: "#374151",
    marginBottom: 6,
  },
});