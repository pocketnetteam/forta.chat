export interface TelemetrySnapshot {
  collectedAt: number;
  platform: string;
  webViewVersion: string | null;
  webViewMajor: number | null;
  webViewState: string | null;
  androidVersion: string | null;
  androidSdk: number | null;
  deviceModel: string;
  deviceManufacturer: string;
  screenWidth: number;
  screenHeight: number;
  screenDpr: number;
}
