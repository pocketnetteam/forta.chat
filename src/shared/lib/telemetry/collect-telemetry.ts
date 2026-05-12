import { Device } from '@capacitor/device';
import { isAndroid, isIOS } from '@/shared/lib/platform';
import type { TelemetrySnapshot } from './telemetry.types';

/**
 * Collect device/WebView telemetry for bug correlation.
 * Non-throwing — all native calls are wrapped in try/catch.
 *
 * On Android we query @capgo/capacitor-webview-version-checker for the
 * exact WebView build (varies per OEM/firmware). On iOS WebKit is pinned
 * to the OS version, so we synthesize a WKWebView label from the iOS
 * version reported by @capacitor/device.
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
  } else if (isIOS) {
    const osVersion = info.osVersion ?? '';
    webViewVersion = osVersion || null;
    const major = parseInt(osVersion.split('.')[0] ?? '', 10);
    webViewMajor = Number.isFinite(major) ? major : null;
    webViewState = `WKWebView (iOS ${osVersion || 'unknown'})`;
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
