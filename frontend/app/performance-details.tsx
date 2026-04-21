import React, { useMemo } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";

type PerformanceDetailsPayload = {
  averageScore?: number;
  totalAttempts?: number;
  bestTitle?: string;
  bestGrade?: string;
  latestPractice?: string;
  speechAverage?: number;
  contentAverage?: number;
  bodyAverage?: number;
  emotionAverage?: number;
};

function categoryTone(score: number) {
  if (score >= 85) {
    return { bg: "#DCFCE7", text: "#166534", icon: "trending-up" as const };
  }
  if (score >= 70) {
    return { bg: "#DBEAFE", text: "#1D4ED8", icon: "chart-line" as const };
  }
  return { bg: "#FEE2E2", text: "#B91C1C", icon: "alert-circle-outline" as const };
}

export default function PerformanceDetailsScreen() {
  const params = useLocalSearchParams<{ data?: string }>();

  const details = useMemo<PerformanceDetailsPayload>(() => {
    try {
      return JSON.parse(String(params.data || "{}"));
    } catch {
      return {};
    }
  }, [params.data]);

  const categories = [
    {
      label: "Speech Delivery",
      score: details.speechAverage ?? 0,
      description: "Pacing, clarity, vocal control, and speaking consistency.",
    },
    {
      label: "Content Alignment",
      score: details.contentAverage ?? 0,
      description: "How well your message stayed aligned with your outline.",
    },
    {
      label: "Body Language",
      score: details.bodyAverage ?? 0,
      description: "Posture, movement, stability, and physical presence.",
    },
    {
      label: "Emotion & Presence",
      score: details.emotionAverage ?? 0,
      description: "Facial expression, composure, and confidence cues.",
    },
  ];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Pressable style={styles.logoButton} onPress={() => router.replace("/")}>
          <Text style={styles.logoText}>SpeakEZ</Text>
        </Pressable>

        <View style={styles.heroCard}>
          <Text style={styles.heroEyebrow}>Performance Details</Text>
          <Text style={styles.heroTitle}>Your progress by category</Text>
          <Text style={styles.heroSubtitle}>
            Review category-level averages to see where your strongest progress is
            and which areas deserve the next round of focus.
          </Text>
        </View>

        <View style={styles.overviewRow}>
          <View style={styles.overviewCard}>
            <Text style={styles.overviewValue}>{details.averageScore ?? 0}</Text>
            <Text style={styles.overviewLabel}>Overall Average</Text>
          </View>
          <View style={styles.overviewCard}>
            <Text style={styles.overviewValue}>{details.totalAttempts ?? 0}</Text>
            <Text style={styles.overviewLabel}>Total Attempts</Text>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Best Session</Text>
          <Text style={styles.summaryValue}>
            {details.bestTitle || "No sessions yet"} • {details.bestGrade || "--"}
          </Text>
          <Text style={styles.summaryMeta}>
            Latest practice: {details.latestPractice || "No recent practice"}
          </Text>
        </View>

        <View style={styles.categoryList}>
          {categories.map((category) => {
            const tone = categoryTone(category.score);
            return (
              <View key={category.label} style={styles.categoryCard}>
                <View style={styles.categoryHeader}>
                  <View style={[styles.categoryIconWrap, { backgroundColor: tone.bg }]}>
                    <MaterialCommunityIcons
                      name={tone.icon}
                      size={22}
                      color={tone.text}
                    />
                  </View>
                  <View style={styles.categoryCopy}>
                    <Text style={styles.categoryTitle}>{category.label}</Text>
                    <Text style={styles.categoryDescription}>{category.description}</Text>
                  </View>
                  <Text style={[styles.categoryScore, { color: tone.text }]}>
                    {category.score}/100
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.max(0, Math.min(category.score, 100))}%`,
                        backgroundColor: tone.text,
                      },
                    ]}
                  />
                </View>
              </View>
            );
          })}
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
    padding: 24,
    paddingBottom: 40,
  },
  logoButton: {
    alignItems: "center",
    marginBottom: 18,
  },
  logoText: {
    fontSize: 38,
    fontFamily: "PTSerifBold",
    color: "#1D4ED8",
  },
  heroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    padding: 28,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  heroEyebrow: {
    color: "#2563EB",
    fontWeight: "700",
    fontSize: 13,
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  heroTitle: {
    fontSize: 34,
    lineHeight: 40,
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 10,
  },
  heroSubtitle: {
    color: "#475569",
    fontSize: 16,
    lineHeight: 24,
  },
  overviewRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 18,
  },
  overviewCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    paddingVertical: 22,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    alignItems: "center",
  },
  overviewValue: {
    fontSize: 30,
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 4,
  },
  overviewLabel: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
  },
  summaryCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    padding: 20,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  summaryTitle: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  summaryValue: {
    fontSize: 18,
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 6,
  },
  summaryMeta: {
    fontSize: 14,
    color: "#475569",
  },
  categoryList: {
    gap: 14,
  },
  categoryCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  categoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 14,
  },
  categoryIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  categoryCopy: {
    flex: 1,
  },
  categoryTitle: {
    fontSize: 18,
    fontFamily: "PTSerifBold",
    color: "#0F172A",
    marginBottom: 4,
  },
  categoryDescription: {
    fontSize: 13,
    color: "#64748B",
    lineHeight: 19,
  },
  categoryScore: {
    fontSize: 18,
    fontWeight: "800",
  },
  progressTrack: {
    height: 10,
    backgroundColor: "#E2E8F0",
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
});
