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

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Session Summary</Text>
        <Text style={styles.subtitle}>
          Review your results and focus on the biggest improvement areas.
        </Text>

        {/* 🔥 Global Header (Home button + title) */}
        <AppHeader title="" />

        <FeedbackCard
          title="Speech Delivery"
          value={
            summary?.speech_summary?.overall_assessment || "No speech summary yet"
          }
        />

        <FeedbackCard
          title="Facial Emotion"
          value={
            summary?.emotion_summary?.dominant_emotion || "No emotion summary yet"
          }
        />

        <FeedbackCard
          title="Body Language"
          value={
            summary?.body_summary?.top_feedback?.[0] || "No body summary yet"
          }
        />

        <FeedbackCard
          title="Content Relevance"
          value={
            summary?.content_summary?.topic_status || "No content summary yet"
          }
          subtitle={
            summary?.content_summary?.similarity_score !== undefined
              ? `Similarity score: ${summary.content_summary.similarity_score}`
              : undefined
          }
        />

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
          <Text style={styles.sectionTitle}>Raw Summary Data</Text>
          <Text style={styles.rawText}>
            {JSON.stringify(summary, null, 2)}
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
    fontSize: 28,
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
  rawText: {
    fontSize: 12,
    color: "#374151",
    fontFamily: "Courier",
  },
});