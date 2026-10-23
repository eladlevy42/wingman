import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Bind to all network interfaces (not just localhost) so the dev server is
    // reachable from other devices on the same Wi-Fi — e.g. testing on a phone
    // at http://<computer-LAN-IP>:5173. The /api proxy below still runs on this
    // machine, so backend calls keep working for phone clients too.
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "node",
    exclude: ["e2e/**", "**/node_modules/**"],
  },
});
