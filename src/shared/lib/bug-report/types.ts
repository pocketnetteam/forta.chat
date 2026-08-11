export interface AppEnvironment {
  platform: 'android' | 'ios' | 'electron' | 'web';
  appVersion: string;
  buildNumber: string;
  webViewVersion: string;
  osVersion: string;
  deviceModel: string;
  screen: string;
  locale: string;
  networkType: string;
  torStatus: string;
  matrixReady: boolean;
  currentRoute: string;
  uptime: string;
  memoryMb: string;
  userAgent: string;
}

export interface BugReportInput {
  description: string;
  environment: AppEnvironment;
  screenshots?: string[]; // base64 array
  /** Bastyon address used to derive the anonymous reporter hash */
  reporterAddress?: string;
  /**
   * Session 25 / S3-S4: optional call-pipeline diagnostics. When the
   * report is triggered from a call-related code path, the modal
   * collects these so triage can split S1 (accept-crash), S3 (FCM
   * throttle), and S4 (stale invite) without a repro.
   */
  callDiagnostics?: import('./collect-call-diagnostics').BugReportCallDiagnostics;
  /**
   * Roadmap 7.6 (docs/plans/llama2): `local-ai`'s persisted log export,
   * collected whenever a `local-ai` client exists this session (feature
   * touched at all, not gated on "opened from AI context" — see
   * `entities/local-ai/lib/collect-ai-diagnostics.ts`). The only
   * diagnostic channel for a Capacitor integration that has never run on
   * a real device in the library's own test suite. Type kept local here
   * (not imported from `entities/local-ai`) — `shared/` depends on
   * nothing above it (`CLAUDE.md`).
   */
  aiDiagnostics?: { logs: string };
}
