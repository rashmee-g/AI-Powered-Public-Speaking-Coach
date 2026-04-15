import axios from "axios";
import Constants from "expo-constants";
import { Platform } from "react-native";

export const COACH_WEB_SESSION_KEY = "capstoneCoachSession_v1";

export type CoachWebSessionPayload = {
  sessionId: string;
  expectedText: string;
  keyPoints: string[];
};

/** Persist session on web so refresh keeps the same backend session id. */
export function persistCoachWebSession(payload: CoachWebSessionPayload) {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(COACH_WEB_SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function readCoachWebSession(): CoachWebSessionPayload | null {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(COACH_WEB_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CoachWebSessionPayload;
  } catch {
    return null;
  }
}

export function clearCoachWebSession() {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(COACH_WEB_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function normalizeRouteParam(value: string | string[] | undefined): string {
  if (value == null) return "";
  return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

/** Uvicorn default is 8000 when you omit `--port`. Override with EXPO_PUBLIC_API_URL or EXPO_PUBLIC_API_PORT. */
function apiPort(): string {
  return process.env.EXPO_PUBLIC_API_PORT?.trim() || "8001";
}

/**
 * Resolve backend URL: physical devices need the machine running Metro, not "localhost".
 */
function resolveApiBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, "");
  }

  const port = apiPort();

  if (!__DEV__) {
    return `http://localhost:${port}`;
  }

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return `http://${host}:${port}`;
    }
  }

  if (Platform.OS === "android") {
    return `http://10.0.2.2:${port}`;
  }

  return `http://localhost:${port}`;
}

const API_BASE_URL = resolveApiBaseUrl();

if (__DEV__) {
  console.log("[api] Base URL:", API_BASE_URL, "platform:", Platform.OS);
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  /** DeepFace / first model load can exceed 15s; short timeouts look like “broken” APIs. */
  timeout: 120000,
});

api.interceptors.request.use((config) => {
  console.log("API REQUEST:", config.method, `${config.baseURL}${config.url}`);
  console.log("API BODY:", config.data);
  return config;
});

api.interceptors.response.use(
  (response) => {
    console.log("API RESPONSE:", response.status, response.config.url, response.data);
    return response;
  },
  (error) => {
    console.log("API ERROR:", error?.response?.data || error.message);
    return Promise.reject(error);
  }
);

export async function startSession(payload: {
  expected_text?: string;
  key_points?: string[];
}) {
  const res = await api.post("/session/start", payload);
  return res.data;
}

export async function endSession(sessionId: string) {
  const res = await api.post("/session/end", {
    session_id: sessionId,
  });
  return res.data;
}

export async function checkBackendStatus() {
  const res = await api.get("/status");
  return res.data;
}

export async function analyzeContent(
  sessionId: string,
  transcript: string,
  expectedText?: string,
  keyPoints?: string[]
) {
  const res = await api.post("/analyze/content", {
    session_id: sessionId,
    transcript,
    expected_text: expectedText,
    key_points: keyPoints ?? [],
  });

  return res.data;
}

export async function analyzeFrame(sessionId: string, imageBase64: string) {
  const res = await api.post("/analyze/frame", {
    session_id: sessionId,
    image_base64: imageBase64,
  });
  return res.data;
}

export async function analyzeAudioChunk(sessionId: string, uri: string) {
  const formData = new FormData();
  formData.append("session_id", sessionId);

  if (Platform.OS === "web") {
    const blobRes = await fetch(uri);
    const blob = await blobRes.blob();
    const type = blob.type || "";
    const ext = type.includes("webm")
      ? "webm"
      : type.includes("wav")
        ? "wav"
        : type.includes("mpeg") || type.includes("mp3")
          ? "mp3"
          : "m4a";
    formData.append("audio_file", blob, `chunk.${ext}`);
  } else {
    formData.append("audio_file", {
      uri,
      name: "chunk.m4a",
      type: "audio/m4a",
    } as any);
  }

  
  // Let axios set multipart boundary (manual Content-Type breaks browser uploads).
  const res = await api.post("/analyze/audio-chunk", formData);

  return res.data;
}

export function isSessionExpiredError(err: any): boolean {
  const detail = err?.response?.data?.detail;
  return typeof detail === "string" && detail.toLowerCase().includes("session not found");
}