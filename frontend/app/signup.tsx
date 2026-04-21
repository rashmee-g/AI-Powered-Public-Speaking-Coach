import React, { useState } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  Pressable,
  View,
  Image,
} from "react-native";
import { router } from "expo-router";
import { createCoachUser, persistCoachUser } from "../services/api";

export default function SignupScreen() {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success" | "">("");

  const normalizedUsername = username.trim().toLowerCase();

  const validateInputs = () => {
    if (!name.trim()) {
      return "Please enter your name.";
    }

    if (!normalizedUsername) {
      return "Please enter a username.";
    }

    if (!password.trim()) {
      return "Please enter a password.";
    }

    if (password.trim().length < 6) {
      return "Password must be at least 6 characters.";
    }

    if (password !== confirmPassword) {
      return "Passwords do not match.";
    }

    return "";
  };

  const handleSignup = async () => {
    if (loading) return;

    const validationMessage = validateInputs();
    if (validationMessage) {
      setMessage(validationMessage);
      setMessageTone("error");
      return;
    }

    try {
      setLoading(true);
      setMessage("Creating account...");
      setMessageTone("success");

      const res = await createCoachUser({
        name: name.trim(),
        username: normalizedUsername,
        password,
      });

      persistCoachUser({ username: res.username });
      router.replace("/");
    } catch (err: any) {
      setMessage(err?.response?.data?.detail || err?.message || "Signup failed");
      setMessageTone("error");
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
              Create Your{"\n"}SpeakEZ Account.
            </Text>

            <Text style={styles.heroSubtitle}>
              Start saving sessions, tracking progress, and improving with every practice.
            </Text>
          </View>
        </View>

        <View style={styles.right}>
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Create Account</Text>
            <Text style={styles.formSubtitle}>
              Sign up to start practicing and reviewing your speaking sessions.
            </Text>

            {!!message && (
              <View
                style={[
                  styles.messageBox,
                  messageTone === "error" ? styles.messageError : styles.messageSuccess,
                ]}
              >
                <Text
                  style={[
                    styles.messageText,
                    messageTone === "error" ? styles.messageErrorText : styles.messageSuccessText,
                  ]}
                >
                  {message}
                </Text>
              </View>
            )}

            <TextInput
              style={styles.input}
              placeholder="Full Name"
              value={name}
              onChangeText={(value) => {
                setName(value);
                if (message) setMessage("");
              }}
              editable={!loading}
            />

            <TextInput
              style={styles.input}
              placeholder="Username"
              value={username}
              onChangeText={(value) => {
                setUsername(value);
                if (message) setMessage("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />

            <TextInput
              style={styles.input}
              placeholder="Password"
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                if (message) setMessage("");
              }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />

            <TextInput
              style={styles.input}
              placeholder="Confirm Password"
              value={confirmPassword}
              onChangeText={(value) => {
                setConfirmPassword(value);
                if (message) setMessage("");
              }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              onSubmitEditing={handleSignup}
            />

            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                (loading || pressed) && styles.buttonDisabled,
              ]}
              onPress={handleSignup}
              disabled={loading}
            >
              <Text style={styles.primaryText}>
                {loading ? "Creating Account..." : "Sign Up"}
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.secondaryBtn,
                (loading || pressed) && styles.buttonDisabled,
              ]}
              onPress={() => router.push("/login")}
              disabled={loading}
            >
              <Text style={styles.secondaryText}>Back to Login</Text>
            </Pressable>
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
  messageBox: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 15,
    padding: 12,
  },
  messageText: {
    fontSize: 14,
    fontWeight: "600",
  },
  messageError: {
    backgroundColor: "#fef2f2",
    borderColor: "#fecaca",
  },
  messageErrorText: {
    color: "#b91c1c",
  },
  messageSuccess: {
    backgroundColor: "#ecfdf5",
    borderColor: "#a7f3d0",
  },
  messageSuccessText: {
    color: "#047857",
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
