// Stands in for expo-constants under Vitest, which runs in Node and has no Expo
// runtime to read a manifest from. The hostUri is deliberately a realistic LAN
// address so a test that forgets to set EXPO_PUBLIC_API_URL still exercises the
// derivation path rather than the error path.
export default {
  // The eas.projectId is what getExpoPushTokenAsync requires; present here so
  // push tests exercise registration rather than the "no EAS project" skip.
  expoConfig: {
    hostUri: "192.168.1.42:8081",
    extra: { eas: { projectId: "00000000-0000-4000-8000-000000000000" } },
  },
  easConfig: { projectId: "00000000-0000-4000-8000-000000000000" },
};
