import { currentPlatform, isNative, isAndroid } from '@/shared/lib/platform';
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
 * Collect device environment for bug reports.
 * Reuses the same approach as collectTelemetry() from the About screen.
 * Non-throwing — all native calls are wrapped in try/catch.
 */
export async function collectEnvironment(): Promise<AppEnvironment> {
  let appVersion = '';
  let buildNumber = '';

  if (isNative) {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      appVersion = info.version ?? '';
      buildNumber = info.build ?? '';
    } catch {
      // Capacitor App unavailable
    }
  }

  let webViewVersion = '';
  let osVersion = '';
  let deviceModel = '';

  if (isNative) {
    try {
      const { Device } = await import('@capacitor/device');
      const info = await Device.getInfo();
      osVersion = info.osVersion ?? '';
      deviceModel = [info.manufacturer, info.model].filter(Boolean).join(' ');
    } catch {
      // Capacitor Device unavailable
    }

    if (isAndroid) {
      try {
        const { WebviewVersionChecker } = await import(
          '@capgo/capacitor-webview-version-checker'
        );
        const result = await WebviewVersionChecker.check();
        webViewVersion = result.currentVersion ?? '';
      } catch {
        // Plugin unavailable
      }
    }
  }

  // Fallback: parse userAgent for web/electron or if native calls failed
  const ua = navigator.userAgent;

  if (!webViewVersion) {
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    webViewVersion = chromeMatch?.[1] ?? '';
  }

  if (!osVersion) {
    const androidMatch = ua.match(/Android\s+([\d.]+)/);
    const iosMatch = ua.match(/OS\s+([\d_]+)/);
    if (androidMatch) {
      osVersion = androidMatch[1];
    } else if (iosMatch) {
      osVersion = iosMatch[1].replace(/_/g, '.');
    }
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
