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
}
