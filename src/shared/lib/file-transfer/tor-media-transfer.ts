import { Capacitor } from '@capacitor/core';
import { isAndroid } from '@/shared/lib/platform';
import { torService } from '@/shared/lib/tor/tor-service';
import { fileTransferService } from './file-transfer-service';

/** Stream large uploads through TorFile instead of the WebView XHR path. */
export const NATIVE_TOR_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

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

  try {
    const { url, authorization } = getUploadEndpoint();
    const responseBody = await fileTransferService.upload({
      filePath: uri,
      uploadUrl: url,
      mimeType,
      authorization,
      onProgress: onProgress
        ? (percent) => {
            onProgress({
              loaded: Math.round((blob.size * percent) / 100),
              total: blob.size,
            });
          }
        : undefined,
    });

    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    return parseMatrixUploadResponse(responseBody);
  } finally {
    await deleteCacheUpload(cachePath);
  }
}

/** Download media bytes through TorFile → reverse proxy :8181. */
export async function downloadMediaViaTorFile(
  url: string,
  authorization?: string,
): Promise<Blob> {
  const { filePath, mimeType } = await fileTransferService.download({
    url,
    authorization,
  });

  const webPath = Capacitor.convertFileSrc(filePath);
  const response = await fetch(webPath);
  if (!response.ok) {
    throw new Error(`Failed to read Tor download: ${response.status}`);
  }

  const blob = await response.blob();
  return mimeType ? new Blob([blob], { type: mimeType }) : blob;
}
