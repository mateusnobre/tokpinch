import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/dashboard/",
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4100",
      "/ws": { target: "ws://localhost:4100", ws: true },
    },
  },
});
