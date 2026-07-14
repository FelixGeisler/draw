import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_PORT / API_PORT allow E2E tests to run on separate ports
// next to a live dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    proxy: {
      // 127.0.0.1 (not localhost): the API binds loopback IPv4 only, and
      // localhost may resolve to ::1 first.
      "/api": `http://127.0.0.1:${process.env.API_PORT || 3001}`,
    },
  },
});
