import React, { forwardRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CameraView } from "expo-camera";


type Props = {
  hasPermission: boolean | null;
};

const CameraPreview = forwardRef<CameraView, Props>(({ hasPermission }, ref) => {
  if (hasPermission === null) {
    return (
      <View style={styles.box}>
        <Text style={styles.text}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={styles.box}>
        <Text style={styles.text}>Camera permission denied</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={ref} style={styles.camera} facing="front" />
    </View>
  );
});

export default CameraPreview;

const styles = StyleSheet.create({
  container: {
    height: 500,
    borderRadius: 20,
    overflow: "hidden",
    marginBottom: 16,
    backgroundColor: "#111827",
  },
  camera: {
    flex: 1,
  },
  box: {
    height: 260,
    borderRadius: 20,
    backgroundColor: "#1f2937",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    marginBottom: 16,
  },
  text: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});