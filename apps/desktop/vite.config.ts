import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed port: the Tauri shell points at it, and the API proxy below keeps the
// browser and the desktop webview on identical URLs.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.WH_API ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
