import { Device } from '@capacitor/device';
import { isAndroid } from '@/shared/lib/platform';
import type { TelemetrySnapshot } from './telemetry.types';

/**
 * Collect device/WebView telemetry for Android bug correlation.
 * Non-throwing — all native calls are wrapped in try/catch.
 */
export async function collectTelemetry(): Promise<TelemetrySnapshot> {
  const info = await Device.getInfo();

  let webViewVersion: string | null = null;
  let webViewMajor: number | null = null;
  let webViewState: string | null = null;

  if (isAndroid) {
    try {
      const { WebviewVersionChecker } = await import(
        '@capgo/capacitor-webview-version-checker'
      );
      const result = await WebviewVersionChecker.check();
      webViewVersion = result.currentVersion ?? null;
      webViewMajor = result.currentMajorVersion ?? null;
      webViewState = result.state ?? null;
    } catch {
      // Plugin unavailable or failed — leave fields null
    }
  }

  const snapshot: TelemetrySnapshot = {
    collectedAt: Date.now(),
    platform: info.platform,
    webViewVersion,
    webViewMajor,
    webViewState,
    androidVersion: info.osVersion ?? null,
    androidSdk: info.androidSDKVersion ?? null,
    deviceModel: info.model ?? 'unknown',
    deviceManufacturer: info.manufacturer ?? 'unknown',
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenDpr: window.devicePixelRatio,
  };

  console.info('[Telemetry]', JSON.stringify(snapshot));

  return snapshot;
}
