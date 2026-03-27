import { ref, readonly } from 'vue';
import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

interface TorNativePlugin {
  startDaemon(options?: {
    mode?: 'always' | 'auto' | 'never';
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

class TorService {
  private _ready = ref(false);
  private _progress = ref(0);
  private _state = ref<string>('STOPPED');
  private _proxyPort = ref(0);
  private _initFailed = ref(false);
  private _initPromise: Promise<void> | null = null;
  private _listenersRegistered = false;

  readonly isReady = readonly(this._ready);
  readonly progress = readonly(this._progress);
  readonly state = readonly(this._state);
  readonly initFailed = readonly(this._initFailed);

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

  async init(mode: 'always' | 'auto' | 'never' = 'always'): Promise<void> {
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    await this._registerListeners();

    if (mode === 'never') {
      this._ready.value = true;
      return;
    }

    const result = await TorNative.startDaemon({ mode });
    this._proxyPort.value = result.proxyPort;
    this._ready.value = true;
  }

  /**
   * Start Tor in background — never throws, never blocks boot.
   * Sets isReady=true when bootstrap completes.
   * Sets initFailed=true if Tor cannot start within time limits.
   */
  initBackground(): void {
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    this._initFailed.value = false;
    this._initPromise = this._startWithStallDetection()
      .then(() => {
        console.log('[TOR] Background init succeeded');
      })
      .catch((err) => {
        console.warn('[TOR] Background init failed:', err.message);
        this._initFailed.value = true;
      });
  }

  private async _startWithStallDetection(): Promise<void> {
    const MAX_WAIT = 90_000;
    const STALL_TIMEOUT = 20_000;

    await this._registerListeners();

    const startPromise = TorNative.startDaemon({ mode: 'always' })
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
    if (!isNative) return;
    await TorNative.stopDaemon();
    this._ready.value = false;
    this._proxyPort.value = 0;
  }

  async reconfigure(options: {
    mode: string;
    bridgeType?: string;
    bridges?: string[];
  }): Promise<void> {
    if (!isNative) return;
    await TorNative.configure(options);
  }

  async verify(): Promise<{ isTor: boolean; ip: string }> {
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
    if (!isNative) return;
    await TorNative.clearTorCache();
  }
}

export const torService = new TorService();
