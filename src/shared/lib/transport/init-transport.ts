/**
 * Renderer-side transport initialisation for Electron and Capacitor Android.
 *
 * Electron:
 * - Registers the Service Worker (requires app:// origin in prod)
 * - Bridges BroadcastChannel('ExtendedFetch') ↔ window.fetchBridge IPC
 * - Handles AltTransportActive via IPC
 *
 * Capacitor Android:
 * - Registers SW with platform=capacitor
 * - Handles AltTransportActive via torService.isUseWithTor()
 */

import { isAndroid, isNative } from '@/shared/lib/platform';
import { shouldRouteThroughTor } from '@/shared/lib/tor/routing';
import type { FetchBridge } from '@/shared/types/electron';

function requireFetchBridge(): FetchBridge {
  const bridge = window.fetchBridge;
  if (!bridge) {
    throw new Error('[Transport] fetchBridge is not available');
  }
  return bridge;
}

/** @deprecated Import from `@/shared/lib/tor/routing` instead. */
export { TRANSPORT_WHITELIST, isWhitelistedHost } from '@/shared/lib/tor/routing';

function initFetchRetranslator() {
  const fetchBC = new BroadcastChannel('ExtendedFetch');
  const fetchBridge = requireFetchBridge();

  fetchBC.onmessage = ({ data: msg }) => {
    if (msg.name === 'Request') {
      const rid = msg.id;
      fetchBridge.send('FetchBridge:Request', rid, msg.data);

      fetchBridge.on(`FetchBridge:${rid}:InitialData`, (_e, d) =>
        fetchBC.postMessage({ name: 'InitialData', id: rid, data: d }));

      fetchBridge.on(`FetchBridge:${rid}:Data`, (_e, d) =>
        fetchBC.postMessage({ name: 'Data', id: rid, data: d }));

      fetchBridge.on(`FetchBridge:${rid}:End`, () =>
        fetchBC.postMessage({ name: 'End', id: rid }));

      fetchBridge.on(`FetchBridge:${rid}:Error`, (_e, d) =>
        fetchBC.postMessage({ name: 'Error', id: rid, data: d }));
    } else if (msg.name === 'Abort') {
      fetchBridge.send(`FetchBridge:${msg.id}:Abort`);
    }
  };
}

async function handleAltTransportActive(
  url: string,
  resolve: (useTor: boolean) => void,
): Promise<void> {
  try {
    const useTor = await shouldRouteThroughTor(url, async (targetUrl) => {
      if (isNative && isAndroid) {
        const { torService } = await import('@/shared/lib/tor');
        return torService.isUseWithTor(targetUrl);
      }

      const result = await requireFetchBridge().invoke('AltTransportActive', targetUrl);
      return !!result;
    });
    resolve(useTor);
  } catch {
    resolve(false);
  }
}

function initAltTransportHandler() {
  const swBC = new BroadcastChannel('ServiceWorker');

  swBC.onmessage = async ({ data: msg }) => {
    if (msg.name === 'AltTransportActive') {
      const url: string = msg.data.data;
      const id: string = msg.data.id;

      await handleAltTransportActive(url, (useTor) => {
        swBC.postMessage({ name: `AltTransportActive_result[${id}]`, data: useTor });
      });
    }
  };
}

export async function initTransport(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Workers not supported — transport proxy disabled');
    return;
  }

  const proto = location.protocol;
  if (proto !== 'https:' && proto !== 'http:') {
    console.warn(`Service Workers not supported on ${proto} — transport proxy disabled`);
    return;
  }

  try {
    await navigator.serviceWorker.register('./service-worker.js?platform=electron');
  } catch (err) {
    console.error('Service Worker registration failed:', err);
    return;
  }

  initFetchRetranslator();
  initAltTransportHandler();
}

export async function initNativeTransport(): Promise<void> {
  if (!isNative || !isAndroid) return;

  if (!('serviceWorker' in navigator)) {
    console.warn('[Transport] Service Workers not supported — native transport disabled');
    return;
  }

  const proto = location.protocol;
  if (proto !== 'https:' && proto !== 'http:') {
    console.warn(`[Transport] Service Workers not supported on ${proto} — native transport disabled`);
    return;
  }

  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const swUrl = `./service-worker.js?platform=capacitor&appVersion=${encodeURIComponent(appVersion)}`;

  try {
    await navigator.serviceWorker.register(swUrl);
    console.info('[Transport] Capacitor Service Worker registered');
  } catch (err) {
    console.error('[Transport] Service Worker registration failed:', err);
    return;
  }

  initAltTransportHandler();
}
