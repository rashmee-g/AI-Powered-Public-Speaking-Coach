import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { router } from "expo-router";

type Props = {
  title?: string;
};

export default function AppHeader({ title = "AI Coach" }: Props) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.homeButton}
        onPress={() => router.replace("/")}
      >
        <Text style={styles.homeText}>Home</Text>
      </TouchableOpacity>

      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  homeButton: {
    alignSelf: "flex-start",
    backgroundColor: "#e5e7eb",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 10,
  },
  homeText: {
    fontWeight: "700",
    color: "#111827",
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: "#111827",
  },
});