import { Capacitor } from '@capacitor/core';
import { isAndroid } from '@/shared/lib/platform';
import { torService } from '@/shared/lib/tor/tor-service';
import { fileTransferService } from './file-transfer-service';

/** Stream large uploads through TorFile instead of the WebView XHR path. */
export const NATIVE_TOR_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * What an upload through Tor is assumed to carry, for the progress estimate only.
 * Measured on the Samsung bench: 6 MB in 47 s, about 130 KB/s (2026-09-19).
 */
const ASSUMED_TOR_UPLOAD_BYTES_PER_SEC = 100 * 1024;
const ESTIMATE_CEILING_PERCENT = 95;
const ESTIMATE_TICK_MS = 1000;

/**
 * Upload progress to show for a file going through Tor.
 *
 * The plugin reports the bytes it handed to the local reverse proxy, which takes the
 * whole body within a second and then spends the real time pushing it through Tor:
 * the ring filled to 100 % at once and sat there for 45 s. Nothing downstream reports
 * how much has left the phone, so the ring follows the time a file of this size is
 * expected to take, never runs ahead of the hand-off, and stops short of full until
 * the server has answered.
 */
export function estimateTorUploadPercent(handedOverPercent: number, elapsedMs: number, sizeBytes: number): number {
  const expectedMs = Math.max(1000, (sizeBytes / ASSUMED_TOR_UPLOAD_BYTES_PER_SEC) * 1000);
  const byTime = (ESTIMATE_CEILING_PERCENT * Math.max(0, elapsedMs)) / expectedMs;
  return Math.floor(Math.max(0, Math.min(ESTIMATE_CEILING_PERCENT, handedOverPercent, byTime)));
}

export interface MediaUploadEndpoint {
  url: string;
  authorization: string;
}

export interface UploadMediaViaTorFileOptions {
  blob: Blob;
  mimeType: string;
  getUploadEndpoint: () => MediaUploadEndpoint;
  onProgress?: (progress: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('gif')) return '.gif';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('pdf')) return '.pdf';
  if (mimeType.includes('ogg')) return '.ogg';
  return '.bin';
}

export function isTorMediaTransferActive(): boolean {
  if (!isAndroid) return false;
  if (torService.mode.value === 'neveruse') return false;
  if (!torService.isReady.value || torService.initFailed.value) return false;
  return torService.matrixBaseUrl.length > 0;
}

export function shouldUseNativeTorUpload(fileSizeBytes: number): boolean {
  return isTorMediaTransferActive() && fileSizeBytes >= NATIVE_TOR_UPLOAD_THRESHOLD_BYTES;
}

export function shouldUseNativeTorDownload(): boolean {
  return isTorMediaTransferActive();
}

export function parseMatrixUploadResponse(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('mxc://')) return trimmed;

  const parsed = JSON.parse(trimmed) as { content_uri?: string };
  if (!parsed.content_uri) {
    throw new Error('Matrix upload response missing content_uri');
  }
  return parsed.content_uri;
}

async function deleteCacheUpload(path: string): Promise<void> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({ path, directory: Directory.Cache });
  } catch {
    // Best-effort cleanup — cache eviction will reclaim the file.
  }
}

/** Upload encrypted/plain media through TorFile → reverse proxy :8181. */
export async function uploadMediaViaTorFile(
  options: UploadMediaViaTorFileOptions,
): Promise<string> {
  if (options.signal?.aborted) {
    throw new DOMException('Upload cancelled', 'AbortError');
  }

  const { blob, mimeType, getUploadEndpoint, onProgress, signal } = options;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const cachePath = `tor-upload-${Date.now()}${extensionForMime(mimeType)}`;
  const base64 = await blobToBase64(blob);

  await Filesystem.writeFile({
    path: cachePath,
    data: base64,
    directory: Directory.Cache,
  });

  const { uri } = await Filesystem.getUri({
    directory: Directory.Cache,
    path: cachePath,
  });

  let handedOverPercent = 0;
  const startedAt = Date.now();
  const report = (): void => {
    const percent = estimateTorUploadPercent(handedOverPercent, Date.now() - startedAt, blob.size);
    onProgress?.({ loaded: Math.round((blob.size * percent) / 100), total: blob.size });
  };
  const ticker = onProgress ? setInterval(report, ESTIMATE_TICK_MS) : null;

  try {
    const { url, authorization } = getUploadEndpoint();
    const responseBody = await fileTransferService.upload({
      filePath: uri,
      uploadUrl: url,
      mimeType,
      authorization,
      onProgress: onProgress
        ? (percent) => {
            handedOverPercent = percent;
            report();
          }
        : undefined,
    });

    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    return parseMatrixUploadResponse(responseBody);
  } finally {
    if (ticker !== null) clearInterval(ticker);
    await deleteCacheUpload(cachePath);
  }
}

/**
 * Longest a download through TorFile may take before the caller stops waiting.
 * The plugin's own connect/read timeouts end a stalled transfer; this only frees
 * the caller, and the media download slot it holds, if the native call never
 * answers at all (audit S4-01).
 */
export const TOR_DOWNLOAD_CEILING_MS = 10 * 60_000;

export interface DownloadMediaViaTorFileOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Settle with `promise`, or reject once `signal` aborts or `timeoutMs` passes. */
function untilAbortOrTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Download cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tor download timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/** Download media bytes through TorFile → reverse proxy :8181. */
export async function downloadMediaViaTorFile(
  url: string,
  authorization?: string,
  options: DownloadMediaViaTorFileOptions = {},
): Promise<Blob> {
  if (options.signal?.aborted) {
    throw new DOMException('Download cancelled', 'AbortError');
  }
  const { filePath, mimeType } = await untilAbortOrTimeout(
    fileTransferService.download({ url, authorization }),
    options.timeoutMs ?? TOR_DOWNLOAD_CEILING_MS,
    options.signal,
  );

  const webPath = Capacitor.convertFileSrc(filePath);
  const response = await fetch(webPath);
  if (!response.ok) {
    throw new Error(`Failed to read Tor download: ${response.status}`);
  }

  const blob = await response.blob();
  return mimeType ? new Blob([blob], { type: mimeType }) : blob;
}
