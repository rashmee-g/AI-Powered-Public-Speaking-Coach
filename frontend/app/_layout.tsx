import { useFonts } from "expo-font";
import { Stack } from "expo-router";

export default function Layout() {
  const [fontsLoaded] = useFonts({
    PTSerif: {
      uri: "https://raw.githubusercontent.com/google/fonts/main/ofl/ptserif/PTSerif-Regular.ttf",
    },
    PTSerifBold: {
      uri: "https://raw.githubusercontent.com/google/fonts/main/ofl/ptserif/PTSerif-Bold.ttf",
    },
  });

  if (!fontsLoaded) {
    return null;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
