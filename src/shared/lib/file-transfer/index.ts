export { fileTransferService } from './file-transfer-service';
export {
  downloadMediaViaTorFile,
  isTorMediaTransferActive,
  NATIVE_TOR_UPLOAD_THRESHOLD_BYTES,
  parseMatrixUploadResponse,
  shouldUseNativeTorDownload,
  shouldUseNativeTorUpload,
  uploadMediaViaTorFile,
} from './tor-media-transfer';
export type { MediaUploadEndpoint, UploadMediaViaTorFileOptions } from './tor-media-transfer';
