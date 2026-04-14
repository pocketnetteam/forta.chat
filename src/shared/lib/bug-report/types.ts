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
}
