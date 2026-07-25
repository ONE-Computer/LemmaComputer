import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  cacheDir: process.env.ONECOMPUTER_VITE_CACHE_DIR,
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "nonidealistic-fulgurant-eneida.ngrok-free.dev"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    proxy: {
      "/api": {
        target: process.env.ONECOMPUTER_CONTROL_URL ?? "http://127.0.0.1:4100",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
        headers: {
          "x-onecomputer-proxy-token": process.env.ONECOMPUTER_WEB_PROXY_TOKEN ?? "local-web-proxy-token-change-me",
        },
      },
    },
  },
  plugins: [react()],
});
