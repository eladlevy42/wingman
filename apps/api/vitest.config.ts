import { defineConfig } from "vitest/config";

// No setupFiles: the only one this project had existed solely to keep the real
// firebase-admin SDK out of the test run, and firebase went with the social
// sign-in it served (#512).
export default defineConfig({
  test: {},
});
