import React from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  title: string;
  value: string;
  subtitle?: string;
};

export default function FeedbackCard({ title, value, subtitle }: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.value}>{value}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  title: {
    fontSize: 14,
    color: "#666",
    marginBottom: 8,
  },
  value: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    color: "#555",
  },
});