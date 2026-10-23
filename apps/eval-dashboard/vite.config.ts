import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Standalone Vite entry, separate from apps/web's product build (issue #250)
// — `pnpm run eval` serves this app on its own port with no product routes
// or nav. Proxies /api the same way apps/web does, so it talks to the same
// running apps/api server.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: true } },
  },
  test: { environment: "node", exclude: ["e2e/**", "**/node_modules/**"] },
});
