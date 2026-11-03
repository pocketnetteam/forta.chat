/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_URL: string;
  readonly VITE_DEFAULT_PRIVATEKEY: string;
  /** Base URL of the bug-report proxy (services/bug-report-proxy). */
  readonly VITE_BUG_REPORT_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
