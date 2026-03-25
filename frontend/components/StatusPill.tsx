import React from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  label: string;
  value: string;
};

function getBg(value: string) {
  const v = value.toLowerCase();

  if (v.includes("good") || v.includes("on topic") || v.includes("neutral")) {
    return "#dff7e8";
  }
  if (v.includes("warning") || v.includes("watch") || v.includes("drift")) {
    return "#fff3d6";
  }
  if (v.includes("error") || v.includes("bad")) {
    return "#ffdede";
  }
  return "#ececec";
}

export default function StatusPill({ label, value }: Props) {
  return (
    <View style={[styles.pill, { backgroundColor: getBg(value) }]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 8,
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    color: "#555",
  },
  value: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
    marginTop: 2,
  },
});