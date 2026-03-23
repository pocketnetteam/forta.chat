import { ref, onScopeDispose, type Ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { FileInfo, Message } from "@/entities/chat";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { hexEncode } from "@/shared/lib/matrix/functions";

interface FileDownloadState {
  loading: boolean;
  error: string | null;
  objectUrl: string | null;
  blob: Blob | null;
}

/** Cache of already-decrypted file object URLs: eventId → objectUrl */
const cache = new Map<string, string>();

/** Revoke all cached blob URLs and clear the cache */
export function revokeAllFileUrls() {
  for (const url of cache.values()) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  cache.clear();
}

/** Download and optionally decrypt a file from the Matrix server.
 *  Needs senderId + timestamp to reconstruct the event for decryptKey(). */
async function downloadAndDecrypt(
  fileInfo: FileInfo,
  roomId: string,
  senderId: string,
  timestamp: number,
): Promise<Blob> {
  if (!fileInfo.url) throw new Error("No file URL");

  // Download the file
  const response = await fetch(fileInfo.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  let blob = await response.blob();

  // If the file has secrets, we need to decrypt it
  if (fileInfo.secrets?.keys) {
    const authStore = useAuthStore();
    const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
    if (!roomCrypto) throw new Error("No room crypto for decryption");

    // Build event-like object for decryptKey — matches the shape expected by
    // decryptKey(): event.content.pbody.secrets.{keys,block}, event.sender, event.origin_server_ts
    // Crypto internals use hex-encoded addresses (via getmatrixid), so re-encode the raw address
    const hexSender = hexEncode(senderId).toLowerCase();
    const event: Record<string, unknown> = {
      content: {
        pbody: {
          secrets: fileInfo.secrets,
        },
      },
      sender: hexSender,
      origin_server_ts: timestamp,
    };

    // Decrypt the symmetric file key
    const decryptKey = await roomCrypto.decryptKey(event);

    // Decrypt the file content
    const decryptedFile = await roomCrypto.decryptFile(blob, decryptKey);
    blob = decryptedFile;
  }

  return blob;
}

/** Composable for downloading and decrypting files/images */
export function useFileDownload() {
  const states = ref<Record<string, FileDownloadState>>({});

  // Auto-cleanup blob URLs when the composable's effect scope is destroyed
  onScopeDispose(() => {
    revokeAllFileUrls();
  });

  const getState = (eventId: string): FileDownloadState => {
    if (!states.value[eventId]) {
      states.value[eventId] = {
        loading: false,
        error: null,
        objectUrl: cache.get(eventId) ?? null,
        blob: null,
      };
    }
    return states.value[eventId];
  };

  /** Download (and decrypt if needed) a file message */
  const download = async (message: Message) => {
    if (!message.fileInfo) return null;

    const eventId = message.id;

    // Already cached
    if (cache.has(eventId)) {
      const state = getState(eventId);
      state.objectUrl = cache.get(eventId)!;
      return state.objectUrl;
    }

    const state = getState(eventId);
    if (state.loading) return; // Already downloading

    state.loading = true;
    state.error = null;

    try {
      const blob = await downloadAndDecrypt(
        message.fileInfo,
        message.roomId,
        message.senderId,
        message.timestamp,
      );
      const mimeType = message.fileInfo.type || "application/octet-stream";
      const typedBlob = new Blob([blob], { type: mimeType });
      const url = URL.createObjectURL(typedBlob);

      state.objectUrl = url;
      state.blob = typedBlob;
      cache.set(eventId, url);

      return url;
    } catch (e) {
      console.error("[use-file-download] download error:", e);
      state.error = String(e);
      return null;
    } finally {
      state.loading = false;
    }
  };

  /** Trigger browser download for a file */
  const saveFile = (objectUrl: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /** Format file size for display */
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
  };

  return {
    states: states as Ref<Record<string, FileDownloadState>>,
    getState,
    download,
    saveFile,
    formatSize,
  };
}
