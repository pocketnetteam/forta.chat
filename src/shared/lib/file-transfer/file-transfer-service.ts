import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

/** Bridge contract shared by the Android `TorFilePlugin.kt` (HTTP through
 *  Tor SOCKS at 127.0.0.1:8181) and the iOS `IOSTorFilePlugin.swift`
 *  (URLSession direct HTTPS — no Tor on iOS, per project decision).
 *
 *  Both implementations register under the JS-facing name `"TorFile"` so
 *  the call sites here pick the right native module without an isIOS
 *  branch.
 *
 *  `id` (optional) — caller-supplied progress identifier so concurrent
 *  uploads/downloads can be demultiplexed via the `progress` event.
 *  iOS echoes it back inside the event payload; Android does not yet
 *  emit `id`, in which case the listener treats every event as matching
 *  the active call (single-transfer semantics — same as before this
 *  parameter existed). */
export interface TorFileNativePlugin {
  upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
    id?: string;
  }): Promise<{ contentUri: string; statusCode: number }>;
  download(options: {
    url: string;
    authorization?: string;
    id?: string;
  }): Promise<{ filePath: string; mimeType: string; size: number }>;
  addListener(
    event: 'progress',
    cb: (data: { id?: string; percent: number; loaded: number; total: number }) => void,
  ): Promise<{ remove: () => void }>;
}

const TorFile = registerPlugin<TorFileNativePlugin>('TorFile');

class FileTransferService {
  private progressListener: { remove: () => void } | null = null;

  async upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
    /** Optional per-transfer identifier — see `TorFileNativePlugin.id`.
     *  Recommended: pass the Matrix `messageId` so the progress event
     *  can be matched back to the message bubble even when several
     *  uploads are in flight (chat with bulk forwards / share-target). */
    id?: string;
    onProgress?: (percent: number) => void;
  }): Promise<string> {
    if (!isNative) {
      throw new Error('FileTransferService.upload() is native-only. Use fetch on web.');
    }

    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = await TorFile.addListener('progress', (data) => {
        // Filter only when both the caller supplied an id AND the native
        // event echoed one back. If either side omits it (Android today,
        // or callers that do not care about per-transfer demux), fall
        // through and accept every event — same behaviour as before this
        // parameter existed.
        if (options.id && data.id && data.id !== options.id) return;
        options.onProgress!(data.percent);
      });
    }

    try {
      const result = await TorFile.upload({
        filePath: options.filePath,
        uploadUrl: options.uploadUrl,
        mimeType: options.mimeType,
        authorization: options.authorization,
        id: options.id,
      });
      return result.contentUri;
    } finally {
      this.progressListener?.remove();
      this.progressListener = null;
    }
  }

  async download(options: {
    url: string;
    authorization?: string;
    /** Optional per-transfer identifier — see `TorFileNativePlugin.id`. */
    id?: string;
    onProgress?: (percent: number) => void;
  }): Promise<{ filePath: string; mimeType: string }> {
    if (!isNative) {
      throw new Error('FileTransferService.download() is native-only.');
    }

    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = await TorFile.addListener('progress', (data) => {
        if (options.id && data.id && data.id !== options.id) return;
        options.onProgress!(data.percent);
      });
    }

    try {
      const result = await TorFile.download({
        url: options.url,
        authorization: options.authorization,
        id: options.id,
      });
      return { filePath: result.filePath, mimeType: result.mimeType };
    } finally {
      this.progressListener?.remove();
      this.progressListener = null;
    }
  }
}

export const fileTransferService = new FileTransferService();
