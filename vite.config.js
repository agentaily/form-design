import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base path depends on the deploy target:
//   - GitHub Pages (agentaily.github.io/form-design/) needs "/form-design/" — the default.
//   - Cloudflare Pages (form-design.agentaily.com) is a root domain, so its workflow
//     sets DEPLOY_BASE="/".
//   - dev/preview-from-root stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.DEPLOY_BASE ?? "/form-design/") : "/",
  plugins: [react()],
}));
