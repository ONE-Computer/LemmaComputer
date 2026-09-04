import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rewriteTelegramTokenIntakePath } from "./telegram-intake-path.mjs";

export default defineConfig({
  cacheDir: process.env.LEMMACOMPUTER_VITE_CACHE_DIR,
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "web"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    proxy: {
      "/api/channel-intake": {
        target: process.env.LEMMACOMPUTER_CHANNEL_BROKER_INTAKE_URL ?? "http://127.0.0.1:4102",
        changeOrigin: false,
        rewrite: rewriteTelegramTokenIntakePath,
      },
      "/api": {
        target: process.env.LEMMACOMPUTER_CONTROL_URL ?? "http://127.0.0.1:4100",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
        headers: {
          "x-lemmacomputer-proxy-token": process.env.LEMMACOMPUTER_WEB_PROXY_TOKEN ?? "local-web-proxy-token-change-me",
        },
      },
    },
  },
  plugins: [react()],
});
