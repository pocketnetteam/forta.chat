import { ref, readonly } from 'vue';
import { registerPlugin } from '@capacitor/core';
import { isNative, isIOS } from '@/shared/lib/platform';
import type { TorMode } from '@/entities/tor/model/types';

interface TorNativePlugin {
  startDaemon(options?: {
    mode?: 'always' | 'auto' | 'never' | 'neveruse';
    bridgeType?: string;
    bridges?: string[];
  }): Promise<{ socksPort: number; proxyPort: number; mode: string }>;
  stopDaemon(): Promise<void>;
  getStatus(): Promise<{ progress: number; isReady: boolean; state: string }>;
  configure(options: {
    mode: string;
    bridgeType?: string;
    bridges?: string[];
  }): Promise<void>;
  verifyTor(): Promise<{ isTor: boolean; ip: string; error?: string }>;
  clearTorCache(): Promise<void>;
  isUseWithTor(options: { url: string }): Promise<{ redirect: boolean }>;
  getSettings(): Promise<{
    mode: string;
    bridgeType: string;
    isReady: boolean;
  }>;
  addListener(
    event: 'bootstrapProgress',
    cb: (data: { progress: number }) => void,
  ): Promise<{ remove: () => void }>;
  addListener(
    event: 'stateChanged',
    cb: (data: { state: string }) => void,
  ): Promise<{ remove: () => void }>;
}

const TorNative = registerPlugin<TorNativePlugin>('Tor');

function toNativeMode(mode: TorMode | 'never'): 'always' | 'auto' | 'never' | 'neveruse' {
  if (mode === 'neveruse' || mode === 'never') return 'neveruse';
  return mode;
}

class TorService {
  private _ready = ref(false);
  private _progress = ref(0);
  private _state = ref<string>('STOPPED');
  private _proxyPort = ref(0);
  private _initFailed = ref(false);
  private _mode = ref<TorMode>('neveruse');
  private _bridgeType = ref('NONE');
  private _initPromise: Promise<void> | null = null;
  private _listenersRegistered = false;

  readonly isReady = readonly(this._ready);
  readonly progress = readonly(this._progress);
  readonly state = readonly(this._state);
  readonly initFailed = readonly(this._initFailed);
  readonly mode = readonly(this._mode);
  readonly bridgeType = readonly(this._bridgeType);

  get matrixBaseUrl(): string {
    if (!isNative || !this._ready.value || this._proxyPort.value === 0) {
      return '';
    }
    return `http://127.0.0.1:${this._proxyPort.value}`;
  }

  private async _registerListeners(): Promise<void> {
    if (this._listenersRegistered) return;
    this._listenersRegistered = true;

    await TorNative.addListener('bootstrapProgress', ({ progress }) => {
      this._progress.value = progress;
    });
    await TorNative.addListener('stateChanged', ({ state }) => {
      this._state.value = state;
      this._ready.value = state === 'RUNNING';
    });
  }

  async init(mode: TorMode = 'always'): Promise<void> {
    // Tor is not shipped on iOS — see docs/plans/ios/2026-05-12-ios-overall-plan.md
    // and 2026-05-12-ios-simple-tasks.md Task 4. JS callers see a stable API
    // surface but every native call is a no-op; downstream code falls back to
    // direct HTTPS via the homeserver (matrixBaseUrl below returns '').
    if (isIOS) {
      this._ready.value = true;
      this._state.value = 'NEVER';
      this._proxyPort.value = 0;
      return;
    }
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    this._mode.value = mode;
    await this._registerListeners();

    if (mode === 'neveruse') {
      await TorNative.stopDaemon();
      this._ready.value = false;
      this._proxyPort.value = 0;
      return;
    }

    const result = await TorNative.startDaemon({ mode: toNativeMode(mode) });
    this._proxyPort.value = result.proxyPort;
    this._ready.value = true;
  }

  /**
   * Start Tor in background — never throws, never blocks boot.
   * Sets isReady=true when bootstrap completes.
   * Sets initFailed=true if Tor cannot start within time limits.
   */
  initBackground(mode: TorMode = 'auto'): void {
    if (isIOS) {
      this._ready.value = true;
      this._state.value = 'NEVER';
      this._proxyPort.value = 0;
      return;
    }
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    this._mode.value = mode;
    this._initFailed.value = false;
    this._initPromise = this._startWithStallDetection(mode)
      .then(() => {
        console.log('[TOR] Background init succeeded');
      })
      .catch((err) => {
        console.warn('[TOR] Background init failed:', err.message);
        this._initFailed.value = true;
      });
  }

  private async _startWithStallDetection(mode: TorMode): Promise<void> {
    const MAX_WAIT = 90_000;
    const STALL_TIMEOUT = 20_000;

    await this._registerListeners();

    const startPromise = TorNative.startDaemon({ mode: toNativeMode(mode) })
      .then((result) => {
        this._proxyPort.value = result.proxyPort;
        this._ready.value = true;
      });

    const startTime = Date.now();
    let lastProgress = 0;
    let lastProgressTime = startTime;

    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const now = Date.now();
        const currentProgress = this._progress.value;

        if (this._ready.value) {
          clearInterval(check);
          resolve();
          return;
        }

        if (currentProgress > lastProgress) {
          lastProgress = currentProgress;
          lastProgressTime = now;
        }

        const totalElapsed = now - startTime;
        const stallElapsed = now - lastProgressTime;

        if (totalElapsed > MAX_WAIT) {
          clearInterval(check);
          reject(new Error(
            `Tor init timed out after ${MAX_WAIT / 1000}s (bootstrap at ${currentProgress}%)`,
          ));
        } else if (stallElapsed > STALL_TIMEOUT && currentProgress > 0 && currentProgress < 100) {
          clearInterval(check);
          reject(new Error(
            `Tor bootstrap stalled at ${currentProgress}% (no progress for ${STALL_TIMEOUT / 1000}s)`,
          ));
        }
      }, 2000);

      startPromise
        .then(() => { clearInterval(check); resolve(); })
        .catch((err) => { clearInterval(check); reject(err); });
    });
  }

  async stop(): Promise<void> {
    if (isIOS) return;
    if (!isNative) return;
    await TorNative.stopDaemon();
    this._ready.value = false;
    this._proxyPort.value = 0;
    this._mode.value = 'neveruse';
  }

  async ensureListeners(): Promise<void> {
    if (!isNative) return;
    await this._registerListeners();
  }

  async reconfigure(options: {
    mode: string;
    bridgeType?: string;
    bridges?: string[];
  }): Promise<void> {
    if (isIOS) return;
    if (!isNative) return;

    const mode = options.mode as TorMode;
    this._mode.value = mode;
    if (options.bridgeType) {
      this._bridgeType.value = options.bridgeType;
    }

    if (mode === 'neveruse') {
      await TorNative.configure({ mode: 'neveruse', bridgeType: options.bridgeType });
      this._ready.value = false;
      this._proxyPort.value = 0;
      return;
    }

    await TorNative.configure({
      mode: toNativeMode(mode),
      bridgeType: options.bridgeType ?? this._bridgeType.value,
      bridges: options.bridges,
    });
  }

  async isUseWithTor(url: string): Promise<boolean> {
    if (isIOS || !isNative || this._mode.value === 'neveruse') {
      return false;
    }

    try {
      const result = await TorNative.isUseWithTor({ url });
      return result.redirect;
    } catch {
      return false;
    }
  }

  async getSettings(): Promise<{
    mode: TorMode;
    bridgeType: string;
    isReady: boolean;
  }> {
    if (isIOS || !isNative) {
      return { mode: 'neveruse', bridgeType: 'NONE', isReady: false };
    }

    const settings = await TorNative.getSettings();
    const mode = (settings.mode === 'neveruse' || settings.mode === 'never'
      ? 'neveruse'
      : settings.mode === 'auto'
        ? 'auto'
        : 'always') as TorMode;

    this._mode.value = mode;
    this._bridgeType.value = settings.bridgeType;
    this._ready.value = settings.isReady;

    return { mode, bridgeType: settings.bridgeType, isReady: settings.isReady };
  }

  async verify(): Promise<{ isTor: boolean; ip: string; error?: string }> {
    if (isIOS) return { isTor: false, ip: '', error: 'tor_disabled_on_ios' };
    if (!isNative || !this._ready.value) {
      return { isTor: false, ip: '' };
    }

    try {
      const result = await TorNative.verifyTor();
      return { isTor: result.isTor, ip: result.ip || '' };
    } catch {
      return { isTor: false, ip: '' };
    }
  }

  async clearCache(): Promise<void> {
    if (isIOS) return;
    if (!isNative) return;
    await TorNative.clearTorCache();
  }
}

export const torService = new TorService();
