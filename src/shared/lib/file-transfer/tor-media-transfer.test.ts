// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpload = vi.fn();
const mockDownload = vi.fn();

vi.mock('./file-transfer-service', () => ({
  fileTransferService: {
    upload: (...args: unknown[]) => mockUpload(...args),
    download: (...args: unknown[]) => mockDownload(...args),
  },
}));

vi.mock('@/shared/lib/platform', () => ({
  isAndroid: true,
}));

const torState = {
  mode: 'auto' as 'auto' | 'neveruse' | 'always',
  isReady: true,
  initFailed: false,
  matrixBaseUrl: 'http://127.0.0.1:8181',
};

vi.mock('@/shared/lib/tor/tor-service', () => ({
  torService: {
    get mode() {
      return { value: torState.mode };
    },
    get isReady() {
      return { value: torState.isReady };
    },
    get initFailed() {
      return { value: torState.initFailed };
    },
    get matrixBaseUrl() {
      return torState.matrixBaseUrl;
    },
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (path: string) => `capacitor://localhost/_capacitor_file_${path}`,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    getUri: vi.fn().mockResolvedValue({ uri: 'file://cache/tor-upload.bin' }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('tor-media-transfer routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    torState.mode = 'auto';
    torState.isReady = true;
    torState.initFailed = false;
    torState.matrixBaseUrl = 'http://127.0.0.1:8181';
  });

  it('parseMatrixUploadResponse extracts content_uri from JSON body', async () => {
    const { parseMatrixUploadResponse } = await import('./tor-media-transfer');
    expect(parseMatrixUploadResponse('{"content_uri":"mxc://server/abc"}')).toBe('mxc://server/abc');
  });

  it('parseMatrixUploadResponse accepts bare mxc URI', async () => {
    const { parseMatrixUploadResponse } = await import('./tor-media-transfer');
    expect(parseMatrixUploadResponse('mxc://server/abc')).toBe('mxc://server/abc');
  });

  it('shouldUseNativeTorUpload is true for large files when Tor is active', async () => {
    const {
      shouldUseNativeTorUpload,
      NATIVE_TOR_UPLOAD_THRESHOLD_BYTES,
    } = await import('./tor-media-transfer');

    expect(shouldUseNativeTorUpload(NATIVE_TOR_UPLOAD_THRESHOLD_BYTES)).toBe(true);
    expect(shouldUseNativeTorUpload(NATIVE_TOR_UPLOAD_THRESHOLD_BYTES - 1)).toBe(false);
  });

  it('shouldUseNativeTorUpload is false when Tor mode is neveruse', async () => {
    torState.mode = 'neveruse';
    const { shouldUseNativeTorUpload, NATIVE_TOR_UPLOAD_THRESHOLD_BYTES } = await import(
      './tor-media-transfer'
    );
    expect(shouldUseNativeTorUpload(NATIVE_TOR_UPLOAD_THRESHOLD_BYTES)).toBe(false);
  });

  it('shouldUseNativeTorDownload is true when Tor is active', async () => {
    const { shouldUseNativeTorDownload } = await import('./tor-media-transfer');
    expect(shouldUseNativeTorDownload()).toBe(true);
  });

  it('shouldUseNativeTorDownload is false when Tor is not ready', async () => {
    torState.isReady = false;
    const { shouldUseNativeTorDownload } = await import('./tor-media-transfer');
    expect(shouldUseNativeTorDownload()).toBe(false);
  });
});

describe('uploadMediaViaTorFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    torState.mode = 'always';
    torState.isReady = true;
    mockUpload.mockResolvedValue('{"content_uri":"mxc://server/uploaded"}');
  });

  it('uploads through TorFile and returns parsed mxc URI', async () => {
    const { uploadMediaViaTorFile } = await import('./tor-media-transfer');
    const blob = new Blob(['x'.repeat(6 * 1024 * 1024)], { type: 'application/octet-stream' });

    const contentUri = await uploadMediaViaTorFile({
      blob,
      mimeType: 'application/octet-stream',
      getUploadEndpoint: () => ({
        url: 'https://matrix.example/_matrix/media/v3/upload',
        authorization: 'Bearer token',
      }),
    });

    expect(contentUri).toBe('mxc://server/uploaded');
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadUrl: 'https://matrix.example/_matrix/media/v3/upload',
        authorization: 'Bearer token',
        mimeType: 'application/octet-stream',
      }),
    );
  });
});

// The plugin's percent is the hand-off to the local proxy: 100 % within a second, then
// 45 s of real upload through Tor with a full ring (Samsung, 6 MB, 2026-09-19).
describe('estimateTorUploadPercent', () => {
  const MB = 1024 * 1024;

  it('follows the time a file of this size is expected to take', async () => {
    const { estimateTorUploadPercent } = await import('./tor-media-transfer');
    // 6 MB at the assumed 100 KB/s is 61 s for the 95 % the estimate may show.
    expect(estimateTorUploadPercent(100, 0, 6 * MB)).toBe(0);
    expect(estimateTorUploadPercent(100, 30_000, 6 * MB)).toBe(46);
    expect(estimateTorUploadPercent(100, 600_000, 6 * MB)).toBe(95);
  });

  it('never runs ahead of what the plugin has handed over', async () => {
    const { estimateTorUploadPercent } = await import('./tor-media-transfer');
    expect(estimateTorUploadPercent(10, 600_000, 6 * MB)).toBe(10);
  });

  it('never shows a full ring before the server answers, and survives odd input', async () => {
    const { estimateTorUploadPercent } = await import('./tor-media-transfer');
    expect(estimateTorUploadPercent(100, Number.MAX_SAFE_INTEGER, 1)).toBe(95);
    expect(estimateTorUploadPercent(100, -5, 0)).toBe(0);
  });
});

describe('uploadMediaViaTorFile progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // FileReader in jsdom needs real timeouts; only the ticker and the clock are faked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    torState.mode = 'always';
    torState.isReady = true;
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the ring moving while Tor carries the body, and stops ticking once done', async () => {
    const { uploadMediaViaTorFile } = await import('./tor-media-transfer');
    let finish: (body: string) => void = () => {};
    mockUpload.mockImplementation((opts: { onProgress?: (p: number) => void }) => {
      opts.onProgress?.(100); // the proxy took the whole body at once
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const seen: number[] = [];
    const blob = new Blob(['x'.repeat(6 * 1024 * 1024)]);
    const done = uploadMediaViaTorFile({
      blob,
      mimeType: 'application/octet-stream',
      getUploadEndpoint: () => ({ url: 'https://matrix.example/_matrix/media/v3/upload', authorization: 'Bearer t' }),
      onProgress: ({ loaded, total }) => seen.push(Math.round((loaded * 100) / total)),
    });

    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Math.max(...seen)).toBeLessThan(60);
    expect(Math.max(...seen)).toBeGreaterThan(30);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    finish('{"content_uri":"mxc://server/uploaded"}');
    await expect(done).resolves.toBe('mxc://server/uploaded');
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.length).toBe(count);
  });
});

describe('downloadMediaViaTorFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue({
      filePath: '/data/cache/download.bin',
      mimeType: 'image/jpeg',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['bytes'], { type: 'image/jpeg' })),
    }));
  });

  it('downloads via TorFile and reads the cached file back into a Blob', async () => {
    const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
    const blob = await downloadMediaViaTorFile('https://matrix.example/media');

    expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://matrix.example/media',
      authorization: undefined,
      id: expect.stringMatching(/^tor-dl-/),
    }));
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('forwards native byte progress to the caller', async () => {
    mockDownload.mockImplementation(async (opts: { onProgress: (p: number, l: number, t: number) => void }) => {
      opts.onProgress(50, 500, 1000);
      return { filePath: '/data/cache/download.bin', mimeType: 'video/mp4' };
    });
    const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
    const onProgress = vi.fn();

    await downloadMediaViaTorFile('https://matrix.example/media', { onProgress });

    expect(onProgress).toHaveBeenCalledWith({ loaded: 500, total: 1000 });
  });

  describe('deadlines', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('rejects with DownloadStalledError when the native side stops reporting', async () => {
      // Regression: the native call has no deadline of its own on older
      // builds, so a dead Tor circuit used to spin the bubble forever.
      mockDownload.mockImplementation(() => new Promise(() => {}));
      const { downloadMediaViaTorFile } = await import('./tor-media-transfer');

      const p = downloadMediaViaTorFile('https://matrix.example/media', { idleTimeoutMs: 5_000 });
      const assertion = expect(p).rejects.toMatchObject({ name: 'DownloadStalledError' });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    });

    it('progress events push the idle deadline back', async () => {
      let report: ((p: number, l: number, t: number) => void) | null = null;
      let finish: ((v: { filePath: string; mimeType: string }) => void) | null = null;
      mockDownload.mockImplementation((opts: { onProgress: typeof report }) => {
        report = opts.onProgress;
        return new Promise((resolve) => { finish = resolve; });
      });
      const { downloadMediaViaTorFile } = await import('./tor-media-transfer');

      const p = downloadMediaViaTorFile('https://matrix.example/media', { idleTimeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_000);
      report!(10, 10, 100);
      await vi.advanceTimersByTimeAsync(4_000);
      finish!({ filePath: '/data/cache/download.bin', mimeType: 'video/mp4' });

      await expect(p).resolves.toBeInstanceOf(Blob);
    });

    it('ignores events from a transfer it already gave up on', async () => {
      // Regression: the native call keeps running after a cancel; its events
      // moved the progress ring of the next attempt.
      let report: ((p: number, l: number, t: number) => void) | null = null;
      mockDownload.mockImplementation((opts: { onProgress: typeof report }) => {
        report = opts.onProgress;
        return new Promise(() => {});
      });
      const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
      const ac = new AbortController();
      const onProgress = vi.fn();

      const p = downloadMediaViaTorFile('https://matrix.example/media', { signal: ac.signal, onProgress });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      report!(50, 50, 100);

      expect(onProgress).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with AbortError when the caller cancels', async () => {
      mockDownload.mockImplementation(() => new Promise(() => {}));
      const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
      const ac = new AbortController();

      const p = downloadMediaViaTorFile('https://matrix.example/media', { signal: ac.signal });
      ac.abort();

      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

/** Audit S4-01: a Tor download that never answered held its media slot forever.
 *  The idle deadline (no native progress event) frees the caller now. */
describe('downloadMediaViaTorFile when the native call never answers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDownload.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up after the idle deadline instead of waiting forever', async () => {
    const { downloadMediaViaTorFile, TOR_DOWNLOAD_IDLE_TIMEOUT_MS } = await import('./tor-media-transfer');
    expect(TOR_DOWNLOAD_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000);

    const result = downloadMediaViaTorFile('https://matrix.example/media');
    const settled = vi.fn();
    result.then(settled, settled);

    await vi.advanceTimersByTimeAsync(TOR_DOWNLOAD_IDLE_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow();
  });

  it('stops waiting as soon as the caller cancels', async () => {
    const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
    const controller = new AbortController();

    const result = downloadMediaViaTorFile('https://matrix.example/media', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not start when the caller has already cancelled', async () => {
    const { downloadMediaViaTorFile } = await import('./tor-media-transfer');
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadMediaViaTorFile('https://matrix.example/media', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
