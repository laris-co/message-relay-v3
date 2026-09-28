import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./": the same build works at / and behind Home Assistant ingress (/api/hassio_ingress/<token>/).
// `bun run dev` proxies the PocketBase routes to a local `just dev` on :8789.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8789", ws: true }, "/_": "http://127.0.0.1:8789" },
  },
});
