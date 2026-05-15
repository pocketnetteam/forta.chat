import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fakes for the native TorFile bridge. We capture every call so
// the tests can assert that `id` is propagated from the JS service down to
// the native plugin and that the `progress` listener filters payloads
// correctly when a caller pins a transfer to a specific id.

type ProgressCb = (data: { id?: string; percent: number; loaded: number; total: number }) => void;

const mockUpload = vi.fn();
const mockDownload = vi.fn();
let registeredProgressCb: ProgressCb | null = null;
const mockAddListener = vi.fn(async (_event: 'progress', cb: ProgressCb) => {
  registeredProgressCb = cb;
  return { remove: () => { registeredProgressCb = null; } };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    upload: (...args: unknown[]) => mockUpload(...args),
    download: (...args: unknown[]) => mockDownload(...args),
    addListener: (...args: unknown[]) =>
      mockAddListener(...(args as [event: 'progress', cb: ProgressCb])),
  }),
}));

let mockIsNative = false;
vi.mock('@/shared/lib/platform', () => ({
  get isNative() {
    return mockIsNative;
  },
}));

async function importFreshService() {
  vi.resetModules();
  const mod = await import('./file-transfer-service');
  return mod.fileTransferService;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsNative = true;
  registeredProgressCb = null;
  mockUpload.mockResolvedValue({ contentUri: 'mxc://homeserver/abc', statusCode: 200 });
  mockDownload.mockResolvedValue({
    filePath: '/tmp/download_123.png',
    mimeType: 'image/png',
    size: 1024,
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('FileTransferService — web guard', () => {
  it('upload throws on web (isNative=false) without touching the native bridge', async () => {
    mockIsNative = false;
    const svc = await importFreshService();
    await expect(
      svc.upload({ filePath: '/tmp/x.png', uploadUrl: 'https://hs', mimeType: 'image/png' }),
    ).rejects.toThrow(/native-only/);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('download throws on web', async () => {
    mockIsNative = false;
    const svc = await importFreshService();
    await expect(svc.download({ url: 'https://hs/file' })).rejects.toThrow(/native-only/);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('FileTransferService — id propagation', () => {
  it('upload forwards id verbatim to TorFile.upload', async () => {
    const svc = await importFreshService();
    await svc.upload({
      filePath: '/tmp/photo.jpg',
      uploadUrl: 'https://hs/upload',
      mimeType: 'image/jpeg',
      authorization: 'Bearer abc',
      id: 'msg-42',
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledWith({
      filePath: '/tmp/photo.jpg',
      uploadUrl: 'https://hs/upload',
      mimeType: 'image/jpeg',
      authorization: 'Bearer abc',
      id: 'msg-42',
    });
  });

  it('download forwards id verbatim to TorFile.download', async () => {
    const svc = await importFreshService();
    await svc.download({
      url: 'https://hs/file/123',
      authorization: 'Bearer xyz',
      id: 'msg-99',
    });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith({
      url: 'https://hs/file/123',
      authorization: 'Bearer xyz',
      id: 'msg-99',
    });
  });

  it('omits id when caller did not provide one (back-compat)', async () => {
    const svc = await importFreshService();
    await svc.upload({
      filePath: '/tmp/a.bin',
      uploadUrl: 'https://hs/upload',
      mimeType: 'application/octet-stream',
    });
    expect(mockUpload).toHaveBeenCalledWith({
      filePath: '/tmp/a.bin',
      uploadUrl: 'https://hs/upload',
      mimeType: 'application/octet-stream',
      authorization: undefined,
      id: undefined,
    });
  });
});

describe('FileTransferService — progress filtering', () => {
  it('routes events whose id matches the upload caller', async () => {
    const svc = await importFreshService();
    const onProgress = vi.fn();
    // Hold the upload promise pending so the listener stays installed
    // while we drive `registeredProgressCb` synchronously.
    let resolveUpload: (v: { contentUri: string; statusCode: number }) => void = () => {};
    mockUpload.mockImplementationOnce(
      () => new Promise<{ contentUri: string; statusCode: number }>((res) => { resolveUpload = res; }),
    );

    const pending = svc.upload({
      filePath: '/tmp/p.jpg',
      uploadUrl: 'https://hs/upload',
      mimeType: 'image/jpeg',
      id: 'msg-1',
      onProgress,
    });

    // Listener installs synchronously after the await on addListener; flush.
    await Promise.resolve();
    expect(registeredProgressCb).not.toBeNull();

    registeredProgressCb!({ id: 'msg-1', percent: 25, loaded: 256, total: 1024 });
    registeredProgressCb!({ id: 'msg-2', percent: 50, loaded: 512, total: 1024 });
    registeredProgressCb!({ id: 'msg-1', percent: 75, loaded: 768, total: 1024 });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 25);
    expect(onProgress).toHaveBeenNthCalledWith(2, 75);

    resolveUpload({ contentUri: 'mxc://x', statusCode: 200 });
    await pending;
  });

  it('accepts every event when caller did not specify id (single-transfer mode)', async () => {
    const svc = await importFreshService();
    const onProgress = vi.fn();
    let resolveDownload: (v: { filePath: string; mimeType: string; size: number }) => void = () => {};
    mockDownload.mockImplementationOnce(
      () => new Promise<{ filePath: string; mimeType: string; size: number }>((res) => { resolveDownload = res; }),
    );

    const pending = svc.download({
      url: 'https://hs/file/123',
      onProgress,
    });

    await Promise.resolve();
    expect(registeredProgressCb).not.toBeNull();

    registeredProgressCb!({ id: 'msg-7', percent: 10, loaded: 1, total: 10 });
    registeredProgressCb!({ percent: 60, loaded: 6, total: 10 });
    expect(onProgress).toHaveBeenCalledTimes(2);

    resolveDownload({ filePath: '/x', mimeType: 'image/png', size: 10 });
    await pending;
  });

  it('accepts events from native bridges that omit id (Android compat)', async () => {
    const svc = await importFreshService();
    const onProgress = vi.fn();
    let resolveUpload: (v: { contentUri: string; statusCode: number }) => void = () => {};
    mockUpload.mockImplementationOnce(
      () => new Promise<{ contentUri: string; statusCode: number }>((res) => { resolveUpload = res; }),
    );

    const pending = svc.upload({
      filePath: '/tmp/p.jpg',
      uploadUrl: 'https://hs/upload',
      mimeType: 'image/jpeg',
      id: 'msg-1',
      onProgress,
    });

    await Promise.resolve();
    // Android emits without an `id` field — the listener must still
    // forward, otherwise Android progress bars would freeze entirely.
    registeredProgressCb!({ percent: 33, loaded: 33, total: 100 });
    expect(onProgress).toHaveBeenCalledWith(33);

    resolveUpload({ contentUri: 'mxc://x', statusCode: 200 });
    await pending;
  });

  it('removes the progress listener once the transfer settles', async () => {
    const svc = await importFreshService();
    const onProgress = vi.fn();
    await svc.upload({
      filePath: '/tmp/p.jpg',
      uploadUrl: 'https://hs/upload',
      mimeType: 'image/jpeg',
      id: 'msg-1',
      onProgress,
    });
    // The mock's `remove` clears registeredProgressCb; assert teardown ran.
    expect(registeredProgressCb).toBeNull();
  });
});
