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

  readonly isReady = readonly(this._ready);
  readonly progress = readonly(this._progress);
  readonly state = readonly(this._state);

  get matrixBaseUrl(): string {
    if (!isNative || !this._ready.value || this._proxyPort.value === 0) {
      return '';
    }
    return `http://127.0.0.1:${this._proxyPort.value}`;
  }

  async init(mode: 'always' | 'auto' | 'never' = 'always'): Promise<void> {
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    await TorNative.addListener('bootstrapProgress', ({ progress }) => {
      this._progress.value = progress;
    });

    await TorNative.addListener('stateChanged', ({ state }) => {
      this._state.value = state;
      this._ready.value = state === 'RUNNING';
    });

    if (mode === 'never') {
      this._ready.value = true;
      return;
    }

    const result = await TorNative.startDaemon({ mode });
    this._proxyPort.value = result.proxyPort;
    this._ready.value = true;
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
}

export const torService = new TorService();
