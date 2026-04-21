import { View, Text, TouchableOpacity, StyleSheet, Image } from "react-native";
import { router } from "expo-router";

type Props = {
  title?: string;
};

export default function AppHeader({ title = "AI Coach" }: Props) {
  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => router.replace("/")} activeOpacity={0.85}>
        <Image
          source={require("../assets/images/logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />
      </TouchableOpacity>

      {title ? <Text style={styles.title}>{title}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
    alignItems: "center",
  },
  logo: {
    width: 220,
    height: 72,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    fontFamily: "PTSerifBold",
    color: "#111827",
    textAlign: "center",
  },
});
