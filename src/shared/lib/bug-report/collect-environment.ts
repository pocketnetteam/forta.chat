import { currentPlatform, isNative, isAndroid, isIOS } from '@/shared/lib/platform';
import type { AppEnvironment } from './types';

const appStartTime = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function getNetworkType(): string {
  const conn = (navigator as any).connection;
  if (!conn) return 'unknown';
  return conn.effectiveType ?? conn.type ?? 'unknown';
}

function getMemoryMb(): string {
  const mem = (performance as any).memory;
  if (!mem) return 'n/a';
  return `${Math.round(mem.usedJSHeapSize / 1024 / 1024)}/${Math.round(mem.jsHeapSizeLimit / 1024 / 1024)}`;
}

/**
 * OS and version from a user agent, for when no native API answers. Android and
 * iOS give the bare version, as before; desktop names the OS too, since the
 * report's platform (electron / web) does not. Desktop used to fall through to
 * "n/a" in every Electron report (audit S10-07). Chrome freezes the macOS
 * version at 10.15.7 and Windows 11 still says NT 10.0; better than nothing.
 */
export function parseOsVersionFromUserAgent(ua: string): string {
  const android = ua.match(/Android\s+([\d.]+)/);
  if (android) return android[1];
  const ios = ua.match(/(?:iPhone|iPad|iPod).*?\bOS\s+([\d_]+)/);
  if (ios) return ios[1].replace(/_/g, '.');
  const windows = ua.match(/Windows NT\s+([\d.]+)/);
  if (windows) return `Windows NT ${windows[1]}`;
  const mac = ua.match(/Mac OS X\s+([\d_.]+)/);
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`;
  if (/CrOS/.test(ua)) return 'ChromeOS';
  const linux = ua.match(/Linux\s*([\w-]*)/);
  if (linux) return linux[1] ? `Linux ${linux[1]}` : 'Linux';
  return '';
}

/**
 * Collect device environment for bug reports.
 * Reuses the same approach as collectTelemetry() from the About screen.
 * Non-throwing — all native calls are wrapped in try/catch.
 */
export async function collectEnvironment(): Promise<AppEnvironment> {
  let appVersion = '';
  let buildNumber = '';
  let webViewVersion = '';
  let osVersion = '';
  let deviceModel = '';

  if (isNative) {
    // The three native lookups are independent; ask them at once instead of
    // one after another (audit W2D-03).
    await Promise.all([
      (async () => {
        try {
          const { App } = await import('@capacitor/app');
          const info = await App.getInfo();
          appVersion = info.version ?? '';
          buildNumber = info.build ?? '';
        } catch {
          // Capacitor App unavailable
        }
      })(),
      (async () => {
        try {
          const { Device } = await import('@capacitor/device');
          const info = await Device.getInfo();
          osVersion = info.osVersion ?? '';
          deviceModel = [info.manufacturer, info.model].filter(Boolean).join(' ');
        } catch {
          // Capacitor Device unavailable
        }
      })(),
      (async () => {
        if (!isAndroid) return;
        try {
          const { WebviewVersionChecker } = await import(
            '@capgo/capacitor-webview-version-checker'
          );
          const result = await WebviewVersionChecker.check();
          webViewVersion = result.currentVersion ?? '';
        } catch {
          // Plugin unavailable
        }
      })(),
    ]);

    if (isIOS) {
      // WKWebView is pinned to the OS version on iOS; expose a label that
      // bug-report consumers can group on without a separate plugin.
      webViewVersion = osVersion ? `WKWebView (iOS ${osVersion})` : '';
    }
  }

  // Fallback: parse userAgent for web/electron or if native calls failed
  const ua = navigator.userAgent;

  if (!webViewVersion) {
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    webViewVersion = chromeMatch?.[1] ?? '';
  }

  if (!osVersion) {
    osVersion = parseOsVersionFromUserAgent(ua);
  }

  if (!deviceModel) {
    const modelMatch = ua.match(/;\s*([^;)]+)\s+Build\//);
    deviceModel = modelMatch?.[1]?.trim() ?? '';
  }

  const screen = `${window.screen.width}\u00d7${window.screen.height} @${window.devicePixelRatio}x`;

  // App state — imported lazily to avoid circular deps
  let torStatus = 'n/a';
  let matrixReady = false;
  let currentRoute = '';

  try {
    const { useTorStore } = await import('@/entities/tor');
    const tor = useTorStore();
    const ip = tor.verifyResult?.ip;
    torStatus = tor.isEnabled
      ? `${tor.status}${ip ? ` (${ip})` : ''}`
      : 'disabled';
  } catch {
    // Store not initialized
  }

  try {
    const { useAuthStore } = await import('@/entities/auth');
    matrixReady = useAuthStore().matrixReady;
  } catch {
    // Store not initialized
  }

  try {
    const { useRouter } = await import('vue-router');
    currentRoute = useRouter().currentRoute.value.fullPath;
  } catch {
    currentRoute = window.location.hash || window.location.pathname;
  }

  return {
    platform: currentPlatform,
    appVersion,
    buildNumber,
    webViewVersion,
    osVersion,
    deviceModel,
    screen,
    locale: navigator.language,
    networkType: getNetworkType(),
    torStatus,
    matrixReady,
    currentRoute,
    uptime: formatUptime(Date.now() - appStartTime),
    memoryMb: getMemoryMb(),
    userAgent: ua,
  };
}
