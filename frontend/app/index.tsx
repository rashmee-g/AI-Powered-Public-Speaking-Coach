import React, { useState } from "react";
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
import {
  checkBackendStatus,
  persistCoachWebSession,
  startSession,
} from "../services/api";

export default function HomeScreen() {
  const [expectedText, setExpectedText] = useState("");
  const [keyPoints, setKeyPoints] = useState("");
  const [loading, setLoading] = useState(false);

  const onCheckBackend = async () => {
    try {
      const res = await checkBackendStatus();
      Alert.alert("Backend Connected", JSON.stringify(res, null, 2));
    } catch (err: any) {
      Alert.alert("Backend Error", err?.message || "Could not connect to backend");
    }
  };

  const onStart = async () => {
    console.log("Start button pressed");
  
    try {
      setLoading(true);
  
      const parsedKeyPoints = keyPoints
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  
      console.log("Sending startSession request...");
      const res = await startSession({
        expected_text: expectedText,
        key_points: parsedKeyPoints,
      });
  
      console.log("startSession response:", res);

      persistCoachWebSession({
        sessionId: res.session_id,
        expectedText,
        keyPoints: parsedKeyPoints,
      });

      router.push({
        pathname: "/live-session",
        params: {
          sessionId: res.session_id,
          expectedText,
          keyPoints: JSON.stringify(parsedKeyPoints),
        },
      });
    } catch (err: any) {
      console.log("Start session error:", err);
      console.log("Start session error response:", err?.response?.data);
      Alert.alert(
        "Start Session Error",
        err?.response?.data?.detail || err?.message || "Failed to start session"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>AI Public Speaking Coach</Text>
        <Text style={styles.subtitle}>
          Real-time feedback on speech delivery, body language, facial emotion,
          and content relevance.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Expected Speech / Outline</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholder="Paste your planned speech or outline here..."
            value={expectedText}
            onChangeText={setExpectedText}
            multiline
          />

          <Text style={styles.label}>Key Points</Text>
          <TextInput
            style={styles.input}
            placeholder="example: confidence, eye contact, conclusion"
            value={keyPoints}
            onChangeText={setKeyPoints}
          />

          <TouchableOpacity style={styles.secondaryBtn} onPress={onCheckBackend}>
            <Text style={styles.secondaryBtnText}>Check Backend</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
            onPress={onStart}
            disabled={loading}
          >
            <Text style={styles.primaryBtnText}>
              {loading ? "Starting..." : "Start Practice Session"}
            </Text>
          </TouchableOpacity>
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
    paddingBottom: 40,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: "#111827",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: "#4b5563",
    marginBottom: 20,
    lineHeight: 22,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 20,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
    marginTop: 6,
  },
  input: {
    backgroundColor: "#f3f4f6",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 14,
  },
  multiline: {
    minHeight: 120,
    textAlignVertical: "top",
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
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: "#111827",
    fontWeight: "700",
    fontSize: 15,
  },
});