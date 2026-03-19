import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

interface TorFileNativePlugin {
  upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
  }): Promise<{ contentUri: string; statusCode: number }>;
  download(options: {
    url: string;
    authorization?: string;
  }): Promise<{ filePath: string; mimeType: string; size: number }>;
  addListener(
    event: 'progress',
    cb: (data: { percent: number; loaded: number; total: number }) => void,
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
    onProgress?: (percent: number) => void;
  }): Promise<string> {
    if (!isNative) {
      throw new Error('FileTransferService.upload() is native-only. Use fetch on web.');
    }

    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = await TorFile.addListener('progress', ({ percent }) => {
        options.onProgress!(percent);
      });
    }

    try {
      const result = await TorFile.upload({
        filePath: options.filePath,
        uploadUrl: options.uploadUrl,
        mimeType: options.mimeType,
        authorization: options.authorization,
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
    onProgress?: (percent: number) => void;
  }): Promise<{ filePath: string; mimeType: string }> {
    if (!isNative) {
      throw new Error('FileTransferService.download() is native-only.');
    }

    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = await TorFile.addListener('progress', ({ percent }) => {
        options.onProgress!(percent);
      });
    }

    try {
      const result = await TorFile.download({
        url: options.url,
        authorization: options.authorization,
      });
      return { filePath: result.filePath, mimeType: result.mimeType };
    } finally {
      this.progressListener?.remove();
      this.progressListener = null;
    }
  }
}

export const fileTransferService = new FileTransferService();
