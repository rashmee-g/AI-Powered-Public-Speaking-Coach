import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from "react-native";
import { router } from "expo-router";

import {
  persistCoachWebSession,
  readCoachUser,
  startSession,
} from "../services/api";

export default function StartSessionCard() {
  const [expectedText, setExpectedText] = useState("");
  const [keyPointsText, setKeyPointsText] = useState("");
  const [loading, setLoading] = useState(false);

  const keyPoints = keyPointsText
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const handleStart = async () => {
    try {
      const user = readCoachUser();
      if (!user?.username) {
        router.replace("/login");
        return;
      }

      setLoading(true);

      const res = await startSession({
        username: user.username,
        expected_text: expectedText,
        key_points: keyPoints,
      });

      const sessionId = String(res?.session_id || "");
      if (!sessionId) {
        throw new Error("No session ID returned from backend.");
      }

      persistCoachWebSession({
        sessionId,
        expectedText,
        keyPoints,
      });

      router.push({
        pathname: "/live-session",
        params: {
          sessionId,
          expectedText,
          keyPoints: JSON.stringify(keyPoints),
        },
      });
    } catch (err: any) {
      Alert.alert(
        "Error",
        err?.response?.data?.detail || err?.message || "Failed to start session"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Start a Session</Text>

      <TextInput
        style={[styles.input, styles.large]}
        placeholder="Paste your speech..."
        value={expectedText}
        onChangeText={setExpectedText}
        multiline
      />

      <TextInput
        style={styles.input}
        placeholder="Key points (comma separated)"
        value={keyPointsText}
        onChangeText={setKeyPointsText}
      />

      <TouchableOpacity style={styles.button} onPress={handleStart} disabled={loading}>
        <Text style={styles.buttonText}>
          {loading ? "Starting..." : "Start Practice"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  large: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: "#2563eb",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
});
