import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://agentaily.github.io/form-design/ in production, so the
// build needs that base path; dev/preview-from-root stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/form-design/" : "/",
  plugins: [react()],
}));
