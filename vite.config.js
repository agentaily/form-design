import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { themeInitScript } from "@agentaily/web-kit";

// Anti-FOUC: inline web-kit's themeInitScript synchronously at the top of <head> so the FIRST
// paint already carries the persisted theme (read from the cross-subdomain cookie `agentaily:theme`,
// falling back to localStorage; default dark). Generated FROM the lib — single source of truth —
// so it stays byte-identical to what <ThemeProvider> persists AND to the marketing site
// (form-design-website ships the same themeInitScript({defaultTheme:"dark"})). Runs in dev + build.
function themeFoucPlugin() {
  const script = themeInitScript({ defaultTheme: "dark" });
  return {
    name: "agentaily-theme-fouc",
    transformIndexHtml() {
      return [{ tag: "script", children: script, injectTo: "head-prepend" }];
    },
  };
}

// Base path depends on the deploy target:
//   - GitHub Pages (agentaily.github.io/form-design/) needs "/form-design/" — the default.
//   - Cloudflare Pages (form-design.agentaily.com) is a root domain, so its workflow
//     sets DEPLOY_BASE="/".
//   - dev/preview-from-root stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.DEPLOY_BASE ?? "/form-design/") : "/",
  plugins: [react(), themeFoucPlugin()],
}));
