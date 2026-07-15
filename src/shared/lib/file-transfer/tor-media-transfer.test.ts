import { describe, it, expect, vi, beforeEach } from 'vitest';

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

    expect(mockDownload).toHaveBeenCalledWith({
      url: 'https://matrix.example/media',
      authorization: undefined,
    });
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(0);
  });
});
