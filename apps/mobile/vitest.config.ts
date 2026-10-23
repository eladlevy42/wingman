import path from "node:path";
import { defineConfig } from "vitest/config";

// Vitest covers the client logic that is plain TypeScript — the api client, the
// SSE parser, session storage, and the routing/formatting helpers. Rendering is
// no longer out of scope, but it does not happen here: component tests live in
// `*.test.tsx` and run under Jest via jest-expo, because React Native Testing
// Library needs a real React Native rather than the stubs below (#507,
// ADR-0035). The split is by file extension — `include` takes `.test.ts` only,
// and Jest's testMatch takes `.test.tsx` only — so neither runner ever collects
// the other's files.
//
// The native-module aliases below stand in for packages that cannot load under Node.
// They are the whole reason the logic above is testable off-device.
export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "."),
      "expo-constants": path.resolve(__dirname, "./test/stubs/expo-constants.ts"),
      "@react-native-async-storage/async-storage": path.resolve(
        __dirname,
        "./test/stubs/async-storage.ts"
      ),
      "expo-crypto": path.resolve(__dirname, "./test/stubs/expo-crypto.ts"),
      "expo-notifications": path.resolve(__dirname, "./test/stubs/expo-notifications.ts"),
      "expo-device": path.resolve(__dirname, "./test/stubs/expo-device.ts"),
      "react-native": path.resolve(__dirname, "./test/stubs/react-native.ts"),
      "expo/fetch": path.resolve(__dirname, "./test/stubs/expo-fetch.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
