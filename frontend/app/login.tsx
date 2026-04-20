import React, { useState } from "react";
import {
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from "react-native";
import { router } from "expo-router";
import { login, signup, persistCoachUser } from "../services/api";

export default function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const normalizedUsername = username.trim().toLowerCase();

  const validateInputs = () => {
    if (!normalizedUsername) {
      Alert.alert("Missing Username", "Please enter a username.");
      return false;
    }

    if (!password.trim()) {
      Alert.alert("Missing Password", "Please enter a password.");
      return false;
    }

    return true;
  };

  const handleSignup = async () => {
    if (!validateInputs()) return;

    try {
      setLoading(true);
      const res = await signup(normalizedUsername, password);
      persistCoachUser({ username: res.username });
      router.replace("/");
    } catch (err: any) {
      Alert.alert(
        "Signup Error",
        err?.response?.data?.detail || err?.message || "Signup failed"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!validateInputs()) return;

    try {
      setLoading(true);
      const res = await login(normalizedUsername, password);
      persistCoachUser({ username: res.username });
      router.replace("/");
    } catch (err: any) {
      Alert.alert(
        "Login Error",
        err?.response?.data?.detail || err?.message || "Login failed"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.navbar}>
        <Image
          source={require("./../assets/images/logo.png")}
          style={styles.navLogo}
          resizeMode="contain"
        />
      </View>

      <View style={styles.body}>
        <View style={styles.left}>
          <View style={styles.heroContent}>
            <Image
              source={require("../assets/images/logo.png")}
              style={styles.heroLogo}
              resizeMode="contain"
            />

            <Text style={styles.heroTitle}>
              Speak Better.{"\n"}Perform Stronger.
            </Text>

            <Text style={styles.heroSubtitle}>
              Practice smarter. Speak with confidence.
            </Text>
          </View>
        </View>

        <View style={styles.right}>
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Get Started</Text>
            <Text style={styles.formSubtitle}>
              Log in or create an account to save and review your sessions.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Username"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />

            <TextInput
              style={styles.input}
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />

            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={loading}
            >
              <Text style={styles.primaryText}>
                {loading ? "Loading..." : "Login"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.secondaryBtn, loading && styles.buttonDisabled]}
              onPress={handleSignup}
              disabled={loading}
            >
              <Text style={styles.secondaryText}>Create Account</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },

  navbar: {
    height: 70,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },

  navLogo: {
    width: 120,
    height: 40,
  },

  body: {
    flex: 1,
    flexDirection: "row",
    marginTop: 70,
  },

  left: {
    flex: 1,
    padding: 80,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
  },

  heroContent: {
    maxWidth: 500,
  },

  heroLogo: {
    width: 260,
    height: 120,
    alignSelf: "flex-start",
    marginBottom: 20,
  },

  heroTitle: {
    fontSize: 52,
    fontWeight: "800",
    color: "#111827",
    lineHeight: 58,
    marginBottom: 16,
  },

  heroSubtitle: {
    fontSize: 18,
    color: "#6b7280",
  },

  right: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f1f5f9",
  },

  formCard: {
    width: "70%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 30,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 5,
  },

  formTitle: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 10,
    color: "#111827",
  },

  formSubtitle: {
    fontSize: 14,
    color: "#6b7280",
    marginBottom: 20,
    lineHeight: 20,
  },

  input: {
    backgroundColor: "#f3f4f6",
    padding: 14,
    borderRadius: 12,
    marginBottom: 15,
    fontSize: 15,
  },

  primaryBtn: {
    backgroundColor: "#2563eb",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 10,
  },

  primaryText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },

  secondaryBtn: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
  },

  secondaryText: {
    color: "#111827",
    fontWeight: "600",
  },

  buttonDisabled: {
    opacity: 0.7,
  },
});