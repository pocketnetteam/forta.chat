import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MatrixClientService } from './matrix-client';

const mockSdkUpload = vi.fn();
const mockMxcUrlToHttp = vi.fn((uri: string) =>
  `https://matrix.example/_matrix/media/v3/download/server/${uri.split('/').pop()}`,
);

vi.mock('matrix-js-sdk-bastyon/lib/browser-index.js', () => ({
  createClient: vi.fn(() => ({
    uploadContent: mockSdkUpload,
    mxcUrlToHttp: mockMxcUrlToHttp,
    credentials: { accessToken: 'test-token' },
  })),
  ContentHelpers: { makeTextMessage: vi.fn() },
  MatrixError: class MatrixError extends Error {},
}));

vi.mock('@/shared/lib/file-transfer/tor-media-transfer', () => ({
  shouldUseNativeTorUpload: vi.fn((size: number) => size >= 5 * 1024 * 1024),
  uploadMediaViaTorFile: vi.fn().mockResolvedValue('mxc://server/native'),
  parseMatrixUploadResponse: (body: string) => (JSON.parse(body) as { content_uri: string }).content_uri,
}));

vi.mock('@/shared/lib/transport/direct-upload', () => ({
  routeUploadUrl: async (url: string) => url,
}));

const mockXhrUpload = vi.fn();
vi.mock('@/shared/lib/file-transfer/xhr-upload', () => ({
  uploadBlobWithProgress: (...args: unknown[]) => mockXhrUpload(...args),
}));

describe('MatrixClientService.uploadContent Tor routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSdkUpload.mockResolvedValue({ content_uri: 'mxc://server/sdk' });
  });

  it('uses TorFile for uploads at or above the native threshold', async () => {
    const { shouldUseNativeTorUpload, uploadMediaViaTorFile } = await import(
      '@/shared/lib/file-transfer/tor-media-transfer'
    );
    const service = new MatrixClientService('matrix.example');
    (service as unknown as { client: unknown }).client = {
      uploadContent: mockSdkUpload,
      mxcUrlToHttp: mockMxcUrlToHttp,
      credentials: { accessToken: 'test-token' },
    };

    const blob = new Blob(['x'.repeat(5 * 1024 * 1024)], { type: 'application/octet-stream' });
    const url = await service.uploadContent(blob);

    expect(shouldUseNativeTorUpload).toHaveBeenCalledWith(blob.size);
    expect(uploadMediaViaTorFile).toHaveBeenCalledTimes(1);
    expect(mockSdkUpload).not.toHaveBeenCalled();
    expect(url).toContain('native');
  });

  it('uses SDK upload for small files below the native threshold', async () => {
    const { uploadMediaViaTorFile } = await import('@/shared/lib/file-transfer/tor-media-transfer');
    const service = new MatrixClientService('matrix.example');
    (service as unknown as { client: unknown }).client = {
      uploadContent: mockSdkUpload,
      mxcUrlToHttp: mockMxcUrlToHttp,
      credentials: { accessToken: 'test-token' },
    };

    const blob = new Blob(['small'], { type: 'text/plain' });
    await service.uploadContent(blob);

    expect(uploadMediaViaTorFile).not.toHaveBeenCalled();
    expect(mockSdkUpload).toHaveBeenCalledTimes(1);
  });

  // Regression: the SDK uploads through fetch, so a progress handler never
  // fired and every bubble sat at 0 % until the file was sent.
  it('uploads over XMLHttpRequest when the caller wants progress', async () => {
    mockXhrUpload.mockResolvedValue('{"content_uri":"mxc://server/xhr"}');
    const service = new MatrixClientService('matrix.example');
    (service as unknown as { client: unknown }).client = {
      uploadContent: mockSdkUpload,
      mxcUrlToHttp: mockMxcUrlToHttp,
      getAccessToken: () => 'test-token',
    };
    const onProgress = vi.fn();
    const signal = new AbortController().signal;

    const blob = new Blob(['small'], { type: 'image/png' });
    const url = await service.uploadContent(blob, onProgress, signal);

    expect(mockSdkUpload).not.toHaveBeenCalled();
    expect(mockXhrUpload).toHaveBeenCalledWith({
      url: 'https://matrix.example/_matrix/media/v3/upload',
      authorization: 'Bearer test-token',
      blob,
      contentType: 'image/png',
      onProgress,
      signal,
    });
    expect(url).toContain('xhr');
  });
});
