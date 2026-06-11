// Ambient typing for the Vite-injected env this app reads. Keep in sync with
// .env.example. `import.meta.env` is populated by Vite at build/dev time and by
// vitest at test time (overridable via vi.stubEnv).
interface ImportMetaEnv {
  /** Base URL of the backend; empty/undefined → same-origin relative requests. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
