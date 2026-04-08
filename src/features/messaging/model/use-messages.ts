import { onScopeDispose } from "vue";
import { useChatStore, MessageStatus, MessageType, messageTypeFromMime, normalizeMime } from "@/entities/chat";
import type { FileInfo, Message, LinkPreview } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { getMatrixClientService } from "@/entities/matrix";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { truncateMessage } from "@/shared/lib/message-format";
import { useConnectivity } from "@/shared/lib/connectivity";
import { enqueue, dequeue, getQueue } from "@/shared/lib/offline-queue";
import type { QueuedMessage } from "@/shared/lib/offline-queue";
import { isChatDbReady, getChatDb } from "@/shared/lib/local-db";
import { detectUrl, fetchPreview } from "./use-link-preview";
import { invalidateDownloadCache } from "./use-file-download";
import { registerUploadAbort, unregisterUploadAbort, abortUpload } from "./upload-abort-registry";
import { withTimeout } from "@/shared/lib/with-timeout";
import type { LocalMessageStatus } from "@/shared/lib/local-db/schema";

/** Max time for the entire media pipeline (encrypt + upload + send event + confirm) */
const MEDIA_PIPELINE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/** Max file size for uploads (100 MB — typical Matrix homeserver limit) */
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

/** Track which clientIds are already being cancelled (prevent double invocation) */
const cancellingSet = new Set<string>();

/** Clean up a cancelled upload: mark message, revoke blob, remove pending ops */
async function handleUploadCancelled(
  dbKit: ReturnType<typeof getChatDb>,
  clientId: string,
  localBlobUrl?: string,
): Promise<void> {
  // Guard: prevent double invocation from both abort catch and cancelMediaUpload
  if (cancellingSet.has(clientId)) return;
  cancellingSet.add(clientId);

  try {
    await dbKit.db.messages.where("clientId").equals(clientId).modify({
      status: "cancelled" as LocalMessageStatus,
      uploadProgress: undefined,
      uploadPhase: undefined,
    });

    if (localBlobUrl) URL.revokeObjectURL(localBlobUrl);

    await dbKit.db.pendingOps.where("clientId").equals(clientId).delete();

    // Remove the cancelled message after user sees the feedback
    setTimeout(async () => {
      try {
        await dbKit.db.messages.where("clientId").equals(clientId).delete();
      } catch { /* already deleted */ }
      cancellingSet.delete(clientId);
    }, 3000);
  } catch {
    cancellingSet.delete(clientId);
  }
}

export function useMessages() {
  const chatStore = useChatStore();
  const authStore = useAuthStore();
  const { isOnline } = useConnectivity();

  /** Extract width/height from an image file */
  const getImageDimensions = (file: File): Promise<{ w: number; h: number }> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ w: img.naturalWidth, h: img.naturalHeight });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => { URL.revokeObjectURL(img.src); resolve({ w: 0, h: 0 }); };
      img.src = URL.createObjectURL(file);
    });
  };

  /**
   * Send a text message. Returns true if the optimistic insert succeeded
   * (message is visible in UI), false if the message was silently dropped
   * before any UI update (caller should restore input text).
   */
  const sendMessage = async (content: string, previewDismissed?: boolean): Promise<boolean> => {
    const MAX_MESSAGE_LENGTH = 65536;
    if (content.length > MAX_MESSAGE_LENGTH) {
      console.warn('[sendMessage] Message exceeds max length, truncating');
      content = content.slice(0, MAX_MESSAGE_LENGTH);
    }

    const roomId = chatStore.activeRoomId;
    if (!roomId || !content.trim()) return false;

    const trimmed = truncateMessage(content.trim());

    // ── Dexie path: optimistic insert FIRST, then validate & enqueue ──
    if (isChatDbReady()) {
      let localClientId: string | undefined;
      try {
        const dbKit = getChatDb();

        // 1. Optimistic insert — message appears in UI immediately via liveQuery
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: trimmed,
          type: MessageType.text,
        });
        localClientId = localMsg.clientId;

        // 2. Validate readiness AFTER insert — if not ready, mark as failed
        const matrixService = getMatrixClientService();
        if (!matrixService.isReady()) {
          console.error("[sendMessage] Matrix client not ready — message saved locally as failed", {
            roomId, clientId: localClientId,
          });
          await dbKit.messages.markFailed(localClientId);
          return true; // message IS visible (as failed)
        }

        // 3. Enqueue for background sync (no linkPreview in payload — always async)
        await dbKit.syncEngine.enqueue(
          "send_message",
          roomId,
          { content: trimmed, ...(previewDismissed ? { noPreview: true } : {}) },
          localMsg.clientId,
        );

        // 4. Async preview fetch — fire-and-forget, skip if user dismissed preview
        if (!previewDismissed) {
          const url = detectUrl(trimmed);
          if (url) {
            fetchPreview(url).then(preview => {
              if (!preview) return;
              dbKit.messages.getByClientId(localMsg.clientId).then(msg => {
                if (msg?.localId) {
                  dbKit.db.messages.update(msg.localId, { linkPreview: preview });
                }
              });
            }).catch(() => {});
          }
        }

        return true;
      } catch (e) {
        console.error("[sendMessage] Dexie path failed:", {
          roomId, clientId: localClientId, error: (e as Error).message, stack: (e as Error).stack,
        });
        // If optimistic insert succeeded but enqueue failed — mark as failed so user sees error
        if (localClientId) {
          try {
            const dbKit = getChatDb();
            await dbKit.messages.markFailed(localClientId);
          } catch { /* already logging above */ }
          return true; // message IS visible (as failed)
        }
        // Optimistic insert itself failed — fall through to legacy path
        console.warn("[sendMessage] Falling back to legacy path");
      }
    }

    // ── Legacy path: optimistic addMessage + direct Matrix API call ──
    const matrixService = getMatrixClientService();
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: trimmed,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.text,
    };

    // Optimistic insert FIRST — even if we can't send, user sees their message
    chatStore.addMessage(roomId, message);

    if (!matrixService.isReady()) {
      console.error("[sendMessage] Matrix client not ready (legacy path)", { roomId, tempId });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
      return true; // message IS visible (as failed)
    }

    if (!isOnline.value) {
      enqueue({ id: tempId, roomId, content: trimmed, timestamp: Date.now() });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      return true;
    }

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
      let serverEventId: string;
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(trimmed);
        serverEventId = await matrixService.sendEncryptedText(roomId, encrypted);
      } else {
        serverEventId = await matrixService.sendText(roomId, trimmed);
      }
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("[sendMessage] Failed to send (legacy):", {
        roomId, tempId, error: (e as Error).message, stack: (e as Error).stack,
      });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
    return true;
  };

  /** Drain queued messages when coming back online */
  const drainOfflineQueue = async () => {
    const queue = getQueue();
    if (queue.length === 0) return;
    // Process one at a time
    let msg: QueuedMessage | undefined;
    while ((msg = dequeue())) {
      try {
        const matrixService = getMatrixClientService();
        if (!matrixService.isReady()) break;
        const roomCrypto = authStore.pcrypto?.rooms[msg.roomId] as PcryptoRoomInstance | undefined;
        let serverEventId: string;
        if (roomCrypto?.canBeEncrypt()) {
          const encrypted = await roomCrypto.encryptEvent(msg.content);
          serverEventId = await matrixService.sendEncryptedText(msg.roomId, encrypted);
        } else {
          serverEventId = await matrixService.sendText(msg.roomId, msg.content);
        }
        if (serverEventId) {
          chatStore.updateMessageIdAndStatus(msg.roomId, msg.id, serverEventId, MessageStatus.sent);
        } else {
          chatStore.updateMessageStatus(msg.roomId, msg.id, MessageStatus.sent);
        }
      } catch (e) {
        console.error("[offline-queue] Failed to send queued message:", e);
        chatStore.updateMessageStatus(msg.roomId, msg.id, MessageStatus.failed);
      }
    }
  };

  // Listen for online event to drain queue (with cleanup)
  if (typeof window !== "undefined") {
    window.addEventListener("online", drainOfflineQueue);
    onScopeDispose(() => {
      window.removeEventListener("online", drainOfflineQueue);
    });
  }

  /** Send a file/image/video/audio message */
  const sendFile = async (file: File) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    if (file.size > MAX_UPLOAD_SIZE) {
      console.warn(`[use-messages] File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    // Determine message type from MIME (with fallback for unknown extensions)
    const mime = normalizeMime(file.type);
    const msgType = messageTypeFromMime(mime);

    const localBlobUrl = URL.createObjectURL(file);

    // Dexie-first path: insert into Dexie immediately, upload async
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: file.name,
          type: msgType,
          fileInfo: {
            name: file.name,
            type: mime,
            size: file.size,
            url: localBlobUrl,
          },
          localBlobUrl,
          uploadProgress: 0,
        });

        // Async upload pipeline (with abort support)
        (async () => {
          const controller = registerUploadAbort(localMsg.clientId);
          const { signal } = controller;

          try {
            const checkAbort = () => {
              if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
            };

            await withTimeout((async () => {
              // Phase 1: Encrypt
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "encrypting" });

              const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fileInfo: Record<string, any> = {
                name: file.name,
                type: mime,
                size: file.size,
              };

              let fileToUpload: Blob = file;

              if (roomCrypto?.canBeEncrypt()) {
                const encrypted = await roomCrypto.encryptFile(file);
                fileInfo.secrets = encrypted.secrets;
                fileToUpload = encrypted.file;
              }

              // Phase 2: Upload
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "uploading" });

              const url = await matrixService.uploadContent(fileToUpload, (progress) => {
                const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
                dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
              }, signal);
              fileInfo.url = url;

              // Phase 3: Send event
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "sending_event", uploadProgress: 100 });

              const body = JSON.stringify(fileInfo);
              const serverEventId = await matrixService.sendEncryptedText(roomId, {
                body,
                msgtype: "m.file",
              }, localMsg.clientId);

              const serverFileInfo: FileInfo = {
                name: file.name,
                type: mime,
                size: file.size,
                url,
                ...(fileInfo.secrets ? { secrets: fileInfo.secrets } : {}),
              };
              await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, serverFileInfo, roomId);

              invalidateDownloadCache(localMsg.clientId);
              setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
            })(), MEDIA_PIPELINE_TIMEOUT, "File upload");
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              await handleUploadCancelled(dbKit, localMsg.clientId, localBlobUrl);
            } else {
              console.error("Failed to send file (Dexie path):", e);
              // Only mark failed if not already confirmed (race: timeout fires after confirmMediaSent)
              const current = await dbKit.messages.getByClientId(localMsg.clientId);
              if (current && current.status !== "synced") {
                await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
                  status: "failed" as LocalMessageStatus,
                  uploadProgress: undefined,
                  uploadPhase: undefined,
                });
              }
            }
          } finally {
            unregisterUploadAbort(localMsg.clientId);
          }
        })();

        return;
      } catch (e) {
        console.warn("[use-messages] Dexie sendFile failed, falling back to legacy:", e);
      }
    }

    // Legacy path
    sendFileLegacy(file, roomId, mime, msgType, localBlobUrl, matrixService);
  };

  /** Legacy sendFile — fallback when Dexie is not ready */
  const sendFileLegacy = async (
    file: File,
    roomId: string,
    fileMime: string,
    msgType: MessageType,
    localBlobUrl: string,
    matrixService: ReturnType<typeof getMatrixClientService>,
  ) => {
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: file.name,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: msgType,
      fileInfo: {
        name: file.name,
        type: fileMime,
        size: file.size,
        url: localBlobUrl,
      },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileInfo: Record<string, any> = {
        name: file.name,
        type: fileMime,
        size: file.size,
      };

      let fileToUpload: Blob = file;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        fileInfo.secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      const url = await matrixService.uploadContent(fileToUpload);
      fileInfo.url = url;

      const body = JSON.stringify(fileInfo);
      const serverEventId = await matrixService.sendEncryptedText(roomId, {
        body,
        msgtype: "m.file",
      });

      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send file:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Send an image message (m.image event — compatible with bastyon-chat) */
  const sendImage = async (file: File, options: { caption?: string; captionAbove?: boolean } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const dimensions = await getImageDimensions(file);
    const localBlobUrl = URL.createObjectURL(file);

    // Dexie-first path
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: options.caption || file.name,
          type: MessageType.image,
          fileInfo: {
            name: file.name,
            type: file.type,
            size: file.size,
            url: localBlobUrl,
            w: dimensions.w,
            h: dimensions.h,
            caption: options.caption,
            captionAbove: options.captionAbove,
          },
          localBlobUrl,
          uploadProgress: 0,
        });

        // Async upload pipeline (with abort support)
        (async () => {
          const controller = registerUploadAbort(localMsg.clientId);
          const { signal } = controller;

          try {
            const checkAbort = () => {
              if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
            };

            await withTimeout((async () => {
              // Phase 1: Encrypt
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "encrypting" });

              const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
              let fileToUpload: Blob = file;
              let secrets: Record<string, unknown> | undefined;

              if (roomCrypto?.canBeEncrypt()) {
                const encrypted = await roomCrypto.encryptFile(file);
                secrets = encrypted.secrets;
                fileToUpload = encrypted.file;
              }

              // Phase 2: Upload
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "uploading" });

              const url = await matrixService.uploadContent(fileToUpload, (progress) => {
                const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
                dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
              }, signal);

              // Phase 3: Send event
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "sending_event", uploadProgress: 100 });

              const content: Record<string, unknown> = {
                body: options.caption || "Image",
                msgtype: "m.image",
                url,
                info: {
                  w: dimensions.w,
                  h: dimensions.h,
                  mimetype: file.type,
                  size: file.size,
                  ...(secrets ? { secrets } : {}),
                  ...(options.caption ? { caption: options.caption } : {}),
                  ...(options.captionAbove != null ? { captionAbove: options.captionAbove } : {}),
                },
              };

              const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);

              const serverFileInfo: FileInfo = {
                name: file.name,
                type: file.type,
                size: file.size,
                url,
                w: dimensions.w,
                h: dimensions.h,
                caption: options.caption,
                captionAbove: options.captionAbove,
                ...(secrets ? { secrets: secrets as FileInfo["secrets"] } : {}),
              };
              await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, serverFileInfo, roomId);

              invalidateDownloadCache(localMsg.clientId);
              setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
            })(), MEDIA_PIPELINE_TIMEOUT, "Image upload");
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              await handleUploadCancelled(dbKit, localMsg.clientId, localBlobUrl);
            } else {
              console.error("Failed to send image (Dexie path):", e);
              const current = await dbKit.messages.getByClientId(localMsg.clientId);
              if (current && current.status !== "synced") {
                await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
                  status: "failed" as LocalMessageStatus,
                  uploadProgress: undefined,
                  uploadPhase: undefined,
                });
              }
            }
          } finally {
            unregisterUploadAbort(localMsg.clientId);
          }
        })();

        return;
      } catch (e) {
        console.warn("[use-messages] Dexie sendImage failed, falling back to legacy:", e);
      }
    }

    // Legacy path
    sendImageLegacy(file, roomId, dimensions, localBlobUrl, options, matrixService);
  };

  /** Legacy sendImage — fallback when Dexie is not ready */
  const sendImageLegacy = async (
    file: File,
    roomId: string,
    dimensions: { w: number; h: number },
    localBlobUrl: string,
    options: { caption?: string; captionAbove?: boolean },
    matrixService: ReturnType<typeof getMatrixClientService>,
  ) => {
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: options.caption || file.name,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.image,
      fileInfo: {
        name: file.name,
        type: file.type,
        size: file.size,
        url: localBlobUrl,
        w: dimensions.w,
        h: dimensions.h,
        caption: options.caption,
        captionAbove: options.captionAbove,
      },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      let fileToUpload: Blob = file;
      let secrets: Record<string, unknown> | undefined;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      const url = await matrixService.uploadContent(fileToUpload);

      const content: Record<string, unknown> = {
        body: options.caption || "Image",
        msgtype: "m.image",
        url,
        info: {
          w: dimensions.w,
          h: dimensions.h,
          mimetype: file.type,
          size: file.size,
          ...(secrets ? { secrets } : {}),
          ...(options.caption ? { caption: options.caption } : {}),
          ...(options.captionAbove != null ? { captionAbove: options.captionAbove } : {}),
        },
      };

      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send image:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Send an audio/voice message (m.audio event — compatible with bastyon-chat) */
  const sendAudio = async (file: File, options: { duration?: number; waveform?: number[] } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const localBlobUrl = URL.createObjectURL(file);

    // Dexie-first path
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: "Audio",
          type: MessageType.audio,
          fileInfo: {
            name: file.name,
            type: file.type,
            size: file.size,
            url: localBlobUrl,
            duration: options.duration,
            waveform: options.waveform,
          },
          localBlobUrl,
          uploadProgress: 0,
        });

        // Async upload pipeline (with abort support)
        (async () => {
          const controller = registerUploadAbort(localMsg.clientId);
          const { signal } = controller;

          try {
            const checkAbort = () => {
              if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
            };

            await withTimeout((async () => {
              // Phase 1: Encrypt
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "encrypting" });

              const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

              let fileToUpload: Blob = file;
              let secrets: Record<string, unknown> | undefined;

              if (roomCrypto?.canBeEncrypt()) {
                const encrypted = await roomCrypto.encryptFile(file);
                secrets = encrypted.secrets;
                fileToUpload = encrypted.file;
              }

              // Phase 2: Upload
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "uploading" });

              const url = await matrixService.uploadContent(fileToUpload, (progress) => {
                const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
                dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
              }, signal);

              // Phase 3: Send event
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "sending_event", uploadProgress: 100 });

              const intWaveform = options.waveform?.map((v: number) => Math.round(v * 1024));

              const content: Record<string, unknown> = {
                body: "Audio",
                msgtype: "m.audio",
                url,
                info: {
                  mimetype: file.type,
                  size: Math.round(file.size),
                  duration: options.duration ? Math.round(options.duration * 1000) : undefined,
                  waveform: intWaveform,
                  ...(secrets ? { secrets } : {}),
                },
              };

              const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);

              const serverFileInfo: FileInfo = {
                name: file.name,
                type: file.type,
                size: file.size,
                url,
                duration: options.duration,
                waveform: options.waveform,
                ...(secrets ? { secrets: secrets as FileInfo["secrets"] } : {}),
              };
              await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, serverFileInfo, roomId);

              invalidateDownloadCache(localMsg.clientId);
              setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
            })(), MEDIA_PIPELINE_TIMEOUT, "Audio upload");
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              await handleUploadCancelled(dbKit, localMsg.clientId, localBlobUrl);
            } else {
              console.error("Failed to send audio (Dexie path):", e);
              const current = await dbKit.messages.getByClientId(localMsg.clientId);
              if (current && current.status !== "synced") {
                await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
                  status: "failed" as LocalMessageStatus,
                  uploadProgress: undefined,
                  uploadPhase: undefined,
                });
              }
            }
          } finally {
            unregisterUploadAbort(localMsg.clientId);
          }
        })();

        return;
      } catch (e) {
        console.warn("[use-messages] Dexie sendAudio failed, falling back to legacy:", e);
      }
    }

    // Legacy path
    sendAudioLegacy(file, roomId, localBlobUrl, options, matrixService);
  };

  /** Legacy sendAudio — fallback when Dexie is not ready */
  const sendAudioLegacy = async (
    file: File,
    roomId: string,
    localBlobUrl: string,
    options: { duration?: number; waveform?: number[] },
    matrixService: ReturnType<typeof getMatrixClientService>,
  ) => {
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: "Audio",
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.audio,
      fileInfo: {
        name: file.name,
        type: file.type,
        size: file.size,
        url: localBlobUrl,
        duration: options.duration,
        waveform: options.waveform,
      },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      let fileToUpload: Blob = file;
      let secrets: Record<string, unknown> | undefined;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      const url = await matrixService.uploadContent(fileToUpload);

      const intWaveform = options.waveform?.map((v: number) => Math.round(v * 1024));

      const content: Record<string, unknown> = {
        body: "Audio",
        msgtype: "m.audio",
        url,
        info: {
          mimetype: file.type,
          size: Math.round(file.size),
          duration: options.duration ? Math.round(options.duration * 1000) : undefined,
          waveform: intWaveform,
          ...(secrets ? { secrets } : {}),
        },
      };

      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send audio:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Send a video circle (video note) message — circular video like Telegram */
  const sendVideoCircle = async (file: File, options: { duration?: number } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const localBlobUrl = URL.createObjectURL(file);

    // Dexie-first path
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: "Video message",
          type: MessageType.videoCircle,
          fileInfo: {
            name: file.name,
            type: file.type,
            size: file.size,
            url: localBlobUrl,
            w: 480,
            h: 480,
            duration: options.duration,
            videoNote: true,
          },
          localBlobUrl,
          uploadProgress: 0,
        });

        // Async upload pipeline (with abort support)
        (async () => {
          const controller = registerUploadAbort(localMsg.clientId);
          const { signal } = controller;

          try {
            const checkAbort = () => {
              if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
            };

            await withTimeout((async () => {
              // Phase 1: Encrypt
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "encrypting" });

              const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

              let fileToUpload: Blob = file;
              let secrets: Record<string, unknown> | undefined;

              if (roomCrypto?.canBeEncrypt()) {
                const encrypted = await roomCrypto.encryptFile(file);
                secrets = encrypted.secrets;
                fileToUpload = encrypted.file;
              }

              // Phase 2: Upload
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "uploading" });

              const url = await matrixService.uploadContent(fileToUpload, (progress) => {
                const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
                dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
              }, signal);

              // Phase 3: Send event
              checkAbort();
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
                .modify({ uploadPhase: "sending_event", uploadProgress: 100 });

              const content: Record<string, unknown> = {
                body: "Video message",
                msgtype: "m.video",
                url,
                info: {
                  mimetype: file.type,
                  size: Math.round(file.size),
                  w: 480,
                  h: 480,
                  duration: options.duration ? Math.round(options.duration * 1000) : undefined,
                  videoNote: true,
                  ...(secrets ? { secrets } : {}),
                },
              };

              const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);

              const serverFileInfo: FileInfo = {
                name: file.name,
                type: file.type,
                size: file.size,
                url,
                w: 480,
                h: 480,
                duration: options.duration,
                videoNote: true,
                ...(secrets ? { secrets: secrets as FileInfo["secrets"] } : {}),
              };
              await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, serverFileInfo, roomId);

              invalidateDownloadCache(localMsg.clientId);
              setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
            })(), MEDIA_PIPELINE_TIMEOUT, "Video circle upload");
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              await handleUploadCancelled(dbKit, localMsg.clientId, localBlobUrl);
            } else {
              console.error("Failed to send video circle (Dexie path):", e);
              const current = await dbKit.messages.getByClientId(localMsg.clientId);
              if (current && current.status !== "synced") {
                await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
                  status: "failed" as LocalMessageStatus,
                  uploadProgress: undefined,
                  uploadPhase: undefined,
                });
              }
            }
          } finally {
            unregisterUploadAbort(localMsg.clientId);
          }
        })();

        return;
      } catch (e) {
        console.warn("[use-messages] Dexie sendVideoCircle failed, falling back to legacy:", e);
      }
    }

    // Legacy path
    sendVideoCircleLegacy(file, roomId, localBlobUrl, options, matrixService);
  };

  /** Legacy sendVideoCircle — fallback when Dexie is not ready */
  const sendVideoCircleLegacy = async (
    file: File,
    roomId: string,
    localBlobUrl: string,
    options: { duration?: number },
    matrixService: ReturnType<typeof getMatrixClientService>,
  ) => {
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: "Video message",
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.videoCircle,
      fileInfo: {
        name: file.name,
        type: file.type,
        size: file.size,
        url: localBlobUrl,
        w: 480,
        h: 480,
        duration: options.duration,
        videoNote: true,
      },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      let fileToUpload: Blob = file;
      let secrets: Record<string, unknown> | undefined;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      const url = await matrixService.uploadContent(fileToUpload);

      const content: Record<string, unknown> = {
        body: "Video message",
        msgtype: "m.video",
        url,
        info: {
          mimetype: file.type,
          size: Math.round(file.size),
          w: 480,
          h: 480,
          duration: options.duration ? Math.round(options.duration * 1000) : undefined,
          videoNote: true,
          ...(secrets ? { secrets } : {}),
        },
      };

      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send video circle:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  const loadMessages = async (roomId: string) => {
    await chatStore.loadRoomMessages(roomId, { waitForSdk: true });
  };

  /** Set typing indicator */
  const setTyping = (isTyping: boolean) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();
    matrixService.setTyping(roomId, isTyping);
  };

  /** Toggle a reaction on a message.
   *  - One reaction per user: choosing a different emoji replaces the old one.
   *  - Clicking the same emoji removes it (toggle off).
   *  - Includes optimistic local update for instant feedback.
   *  - Uses SyncEngine queue for reliable delivery with retry. */
  const toggleReaction = async (messageId: string, emoji: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const roomMessages = chatStore.activeMessages;
    const msg = roomMessages.find(m => m.id === messageId);
    if (!msg) return;

    const myAddress = authStore.address ?? "";
    const existingSameEmoji = msg.reactions?.[emoji];

    // Find if user already reacted with ANY emoji on this message
    let existingOtherEmoji: string | undefined;
    let existingOtherEventId: string | undefined;
    if (msg.reactions) {
      for (const [key, data] of Object.entries(msg.reactions)) {
        if (key !== emoji && data.myEventId) {
          existingOtherEmoji = key;
          existingOtherEventId = data.myEventId;
          break;
        }
      }
    }

    const isServerEventId = (id?: string) => id?.startsWith("$");

    try {
      if (existingSameEmoji?.myEventId) {
        // Toggle off: user clicked the same emoji they already reacted with
        const reactionEventId = existingSameEmoji.myEventId;
        if (!isServerEventId(reactionEventId)) return; // still in-flight, ignore
        chatStore.optimisticRemoveReaction(roomId, messageId, emoji, myAddress);
        await matrixService.redactEvent(roomId, reactionEventId);
      } else {
        // Remove previous different-emoji reaction first (one reaction per user)
        if (existingOtherEmoji && isServerEventId(existingOtherEventId)) {
          const prevEventId = existingOtherEventId!;
          chatStore.optimisticRemoveReaction(roomId, messageId, existingOtherEmoji, myAddress);
          await matrixService.redactEvent(roomId, prevEventId);
        }
        // Send new reaction — optimistic update + direct API call
        chatStore.optimisticAddReaction(roomId, messageId, emoji, myAddress);
        const realEventId = await matrixService.sendReaction(roomId, messageId, emoji);
        chatStore.setReactionEventId(roomId, messageId, emoji, realEventId);
      }
    } catch (e) {
      console.error("[Reaction] Failed to toggle reaction:", e);
      await chatStore.loadRoomMessages(roomId, { waitForSdk: true });
    }
  };

  /** Send message with reply context. Returns true if optimistic insert succeeded. */
  const sendReply = async (content: string, previewDismissed?: boolean): Promise<boolean> => {
    const roomId = chatStore.activeRoomId;
    const replyTo = chatStore.replyingTo;
    if (!roomId || !content.trim() || !replyTo) return false;

    const trimmed = content.trim();
    const replyToData = {
      id: replyTo.id,
      senderId: replyTo.senderId,
      content: replyTo.content,
      type: replyTo.type,
    };

    // ── Dexie path: optimistic insert FIRST ──
    if (isChatDbReady()) {
      let localClientId: string | undefined;
      try {
        const dbKit = getChatDb();

        // 1. Optimistic insert
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: trimmed,
          type: MessageType.text,
          replyTo: replyToData,
        });
        localClientId = localMsg.clientId;
        chatStore.replyingTo = null;

        // 2. Validate readiness AFTER insert
        const matrixService = getMatrixClientService();
        if (!matrixService.isReady()) {
          console.error("[sendReply] Matrix client not ready — message saved locally as failed", {
            roomId, clientId: localClientId,
          });
          await dbKit.messages.markFailed(localClientId);
          return true;
        }

        // 3. Enqueue for background sync (no linkPreview — always async)
        await dbKit.syncEngine.enqueue(
          "send_message",
          roomId,
          { content: trimmed, replyToEventId: replyTo.id, ...(previewDismissed ? { noPreview: true } : {}) },
          localMsg.clientId,
        );

        // 4. Async preview fetch — fire-and-forget, skip if user dismissed preview
        if (!previewDismissed) {
          const url = detectUrl(trimmed);
          if (url) {
            fetchPreview(url).then(preview => {
              if (!preview) return;
              dbKit.messages.getByClientId(localMsg.clientId).then(msg => {
                if (msg?.localId) {
                  dbKit.db.messages.update(msg.localId, { linkPreview: preview });
                }
              });
            }).catch(() => {});
          }
        }

        return true;
      } catch (e) {
        console.error("[sendReply] Dexie path failed:", {
          roomId, clientId: localClientId, error: (e as Error).message, stack: (e as Error).stack,
        });
        if (localClientId) {
          try {
            const dbKit = getChatDb();
            await dbKit.messages.markFailed(localClientId);
          } catch { /* already logging above */ }
          return true;
        }
        console.warn("[sendReply] Falling back to legacy path");
      }
    }

    // ── Legacy path ──
    const matrixService = getMatrixClientService();
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: trimmed,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.text,
      replyTo: replyToData,
    };

    // Optimistic insert FIRST
    chatStore.addMessage(roomId, message);
    chatStore.replyingTo = null;

    if (!matrixService.isReady()) {
      console.error("[sendReply] Matrix client not ready (legacy path)", { roomId, tempId });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
      return true;
    }

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      const msgContent: Record<string, unknown> = {
        body: trimmed,
        msgtype: "m.text",
        "m.relates_to": {
          "m.in_reply_to": {
            event_id: replyTo.id,
          },
        },
      };

      let serverEventId: string;
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(trimmed);
        const encContent: Record<string, unknown> = { ...encrypted, "m.relates_to": msgContent["m.relates_to"] };
        serverEventId = await matrixService.sendEncryptedText(roomId, encContent);
      } else {
        serverEventId = await matrixService.sendEncryptedText(roomId, msgContent);
      }

      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("[sendReply] Failed to send (legacy):", {
        roomId, tempId, error: (e as Error).message, stack: (e as Error).stack,
      });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
    return true;
  };

  /** Edit an existing message (Matrix m.replace relation) */
  const editMessage = async (messageId: string, newContent: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !newContent.trim()) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const trimmed = newContent.trim();

    // New path: Dexie local edit → SyncEngine sends to server
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        await dbKit.messages.editLocal(messageId, trimmed);
        await dbKit.syncEngine.enqueue(
          "edit_message",
          roomId,
          { eventId: messageId, newContent: trimmed },
        );
        return;
      } catch (e) {
        console.warn("[use-messages] Dexie editMessage failed, falling back:", e);
      }
    }

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      const editContent: Record<string, unknown> = {
        body: `* ${trimmed}`,
        msgtype: "m.text",
        "m.new_content": {
          body: trimmed,
          msgtype: "m.text",
        },
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: messageId,
        },
      };

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(trimmed);
        const encContent = {
          ...encrypted,
          "m.new_content": { body: trimmed, msgtype: "m.text" },
          "m.relates_to": editContent["m.relates_to"],
        };
        await matrixService.sendEncryptedText(roomId, encContent);
      } else {
        await matrixService.sendEncryptedText(roomId, editContent);
      }

      // Update local message
      chatStore.updateMessageContent(roomId, messageId, trimmed);
    } catch (e) {
      console.error("Failed to edit message:", e);
    }
  };

  /** Delete a message */
  const deleteMessage = async (messageId: string, forEveryone: boolean) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    // New path: Dexie soft-delete → SyncEngine sends redaction
    if (isChatDbReady() && forEveryone) {
      try {
        const dbKit = getChatDb();
        await dbKit.messages.softDelete(messageId);
        await dbKit.syncEngine.enqueue(
          "delete_message",
          roomId,
          { eventId: messageId },
        );
        return;
      } catch (e) {
        console.warn("[use-messages] Dexie deleteMessage failed, falling back:", e);
      }
    }

    try {
      if (forEveryone) {
        await matrixService.redactEvent(roomId, messageId, "deleted");
      }
      chatStore.removeMessage(roomId, messageId);
    } catch (e) {
      console.error("Failed to delete message:", e);
    }
  };

  /** Forward a message to another room — handles text, files, images, audio, video */
  const forwardMessage = async (message: Message, targetRoomId: string, withSenderInfo = true) => {
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    try {
      const roomCrypto = authStore.pcrypto?.rooms[targetRoomId] as PcryptoRoomInstance | undefined;

      const originalForward = message.forwardedFrom;
      const forwardMeta: Record<string, unknown> | undefined = withSenderInfo
        ? {
            sender_id: originalForward?.senderId ?? message.senderId,
            sender_name: originalForward?.senderName
              ?? chatStore.getDisplayName(originalForward?.senderId ?? message.senderId),
          }
        : undefined;

      // Forward file/media messages by re-sending in the proper format
      if (message.fileInfo && message.type !== MessageType.text) {
        const fi = message.fileInfo;

        // Re-encrypt file for target room when source has encryption secrets.
        // Source secrets are per-room (tied to source room members/keys),
        // so they can't be reused in a different room.
        let url = fi.url;
        let newSecrets: Record<string, unknown> | undefined;

        if (fi.secrets?.keys) {
          // Encrypted source → download, decrypt with source room, re-encrypt for target
          const sourceRoomCrypto = authStore.pcrypto?.rooms[message.roomId] as PcryptoRoomInstance | undefined;
          if (!sourceRoomCrypto) throw new Error("No source room crypto for decryption");

          const resp = await fetch(fi.url);
          if (!resp.ok) throw new Error(`File download failed: ${resp.status}`);
          const encryptedBlob = await resp.blob();

          // Reconstruct event object for decryptKey()
          const hexSender = hexEncode(message.senderId).toLowerCase();
          const decryptEvt: Record<string, unknown> = {
            content: { pbody: { secrets: fi.secrets } },
            sender: hexSender,
            origin_server_ts: message.timestamp,
          };
          const fileKey = await sourceRoomCrypto.decryptKey(decryptEvt);
          const decryptedFile = await sourceRoomCrypto.decryptFile(encryptedBlob, fileKey);

          // Re-encrypt for target room (if encrypted), otherwise upload plaintext
          let fileToUpload: Blob = decryptedFile;
          if (roomCrypto?.canBeEncrypt()) {
            const encrypted = await roomCrypto.encryptFile(decryptedFile);
            newSecrets = encrypted.secrets;
            fileToUpload = encrypted.file;
          }
          url = await matrixService.uploadContent(fileToUpload);
        }

        const secretsSpread = newSecrets ? { secrets: newSecrets } : {};
        let content: Record<string, unknown>;

        if (message.type === MessageType.image) {
          content = {
            body: fi.caption || "Image",
            msgtype: "m.image",
            url,
            info: {
              w: fi.w, h: fi.h,
              mimetype: fi.type, size: fi.size,
              ...secretsSpread,
            },
          };
        } else if (message.type === MessageType.audio) {
          content = {
            body: "Audio",
            msgtype: "m.audio",
            url,
            info: {
              mimetype: fi.type, size: fi.size,
              duration: fi.duration ? fi.duration * 1000 : undefined,
              waveform: fi.waveform,
              ...secretsSpread,
            },
          };
        } else if (message.type === MessageType.videoCircle) {
          content = {
            body: "Video message",
            msgtype: "m.video",
            url,
            info: {
              w: 480, h: 480,
              mimetype: fi.type, size: fi.size,
              duration: fi.duration ? fi.duration * 1000 : undefined,
              videoNote: true,
              ...secretsSpread,
            },
          };
        } else if (message.type === MessageType.video) {
          content = {
            body: fi.caption || "Video",
            msgtype: "m.video",
            url,
            info: {
              w: fi.w, h: fi.h,
              mimetype: fi.type, size: fi.size,
              duration: fi.duration ? fi.duration * 1000 : undefined,
              ...secretsSpread,
            },
          };
        } else {
          // Generic file — send as m.file with JSON body (bastyon-chat compat)
          const fileBody: Record<string, unknown> = {
            name: fi.name, type: fi.type, size: fi.size, url,
          };
          if (newSecrets) fileBody.secrets = newSecrets;
          if (fi.w) fileBody.w = fi.w;
          if (fi.h) fileBody.h = fi.h;
          content = { body: JSON.stringify(fileBody), msgtype: "m.file" };
        }

        if (forwardMeta) content["forwarded_from"] = forwardMeta;
        await matrixService.sendEncryptedText(targetRoomId, content);
        return;
      }

      // Forward text message
      const forwardContent: Record<string, unknown> = {
        body: message.content,
        msgtype: "m.text",
      };
      if (forwardMeta) forwardContent["forwarded_from"] = forwardMeta;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(message.content);
        const encContent = { ...encrypted };
        if (forwardMeta) {
          (encContent as Record<string, unknown>)["forwarded_from"] = forwardMeta;
        }
        await matrixService.sendEncryptedText(targetRoomId, encContent);
      } else {
        await matrixService.sendEncryptedText(targetRoomId, forwardContent);
      }
    } catch (e) {
      console.error("Failed to forward message:", e);
    }
  };

  /** Send a PKOIN transfer message.
   *  Uses Dexie optimistic UI (createLocal → syncEngine) so the transfer bubble
   *  appears instantly, just like regular text messages. Falls back to legacy
   *  in-memory path if Dexie is not ready. */
  const sendTransferMessage = async (
    txId: string,
    amount: number,
    receiverAddress: string,
    message?: string,
  ) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;

    const transferInfo = {
      txId,
      amount,
      from: authStore.address ?? "",
      to: receiverAddress,
      message: message || undefined,
    };
    const displayContent = message || `Sent ${amount} PKOIN`;

    // ── Dexie path: optimistic insert FIRST, then enqueue for sync ──
    if (isChatDbReady()) {
      let localClientId: string | undefined;
      try {
        const dbKit = getChatDb();

        // 1. Optimistic insert — transfer appears in UI immediately via liveQuery
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: displayContent,
          type: MessageType.transfer,
          transferInfo,
        });
        localClientId = localMsg.clientId;

        // 2. Validate readiness AFTER insert — if not ready, mark as failed
        const matrixService = getMatrixClientService();
        if (!matrixService.isReady()) {
          console.error("[sendTransferMessage] Matrix client not ready — saved locally as failed");
          await dbKit.messages.markFailed(localClientId);
          return;
        }

        // 3. Enqueue for background sync — SyncEngine.syncSendTransfer() handles
        //    encryption and Matrix API call, then confirms via messageRepo.confirmSent()
        await dbKit.syncEngine.enqueue(
          "send_transfer",
          roomId,
          { txId, amount, from: authStore.address ?? "", to: receiverAddress, message: message || undefined },
          localMsg.clientId,
        );
        return;
      } catch (e) {
        console.error("[sendTransferMessage] Dexie path failed:", e);
        if (localClientId) {
          try { await getChatDb().messages.markFailed(localClientId); } catch { /* already logging */ }
          return; // message IS visible as failed
        }
        console.warn("[sendTransferMessage] Falling back to legacy path");
      }
    }

    // ── Legacy path: in-memory optimistic + direct Matrix API call ──
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const transferBody = JSON.stringify({ _transfer: true, ...transferInfo });
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const optimistic: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: displayContent,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.transfer,
      transferInfo,
    };
    chatStore.addMessage(roomId, optimistic);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
      let serverEventId: string;
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(transferBody);
        serverEventId = await matrixService.sendEncryptedText(roomId, encrypted);
      } else {
        serverEventId = await matrixService.sendText(roomId, transferBody);
      }
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send transfer message:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Send a poll (MSC3381 org.matrix.msc3381.poll.start) */
  const sendPoll = async (question: string, options: string[]) => {
    const chatStore = useChatStore();
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const answers = options.map((text, i) => ({
      id: `opt-${i}`,
      "org.matrix.msc1767.text": text,
      body: text,
    }));

    const content = {
      "org.matrix.msc3381.poll.start": {
        kind: "org.matrix.msc3381.poll.disclosed",
        max_selections: 1,
        question: { body: question, "org.matrix.msc1767.text": question },
        answers,
      },
      "org.matrix.msc1767.text": `Poll: ${question}`,
    };

    try {
      const eventId = await matrixService.sendPollStart(roomId, content);
      // Add optimistic poll message
      const authStore = useAuthStore();
      const pollInfo: import("@/entities/chat").PollInfo = {
        question,
        options: answers.map(a => ({ id: a.id, text: a.body })),
        votes: {},
      };
      chatStore.addMessage(roomId, {
        id: eventId,
        roomId,
        senderId: authStore.address ?? "",
        content: question,
        timestamp: Date.now(),
        status: MessageStatus.sent,
        type: MessageType.poll,
        pollInfo,
      });
    } catch (e) {
      console.error("Failed to send poll:", e);
    }
  };

  /** Vote on a poll */
  const votePoll = async (pollEventId: string, optionId: string) => {
    const chatStore = useChatStore();
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const content = {
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: pollEventId,
      },
      "org.matrix.msc3381.poll.response": {
        answers: [optionId],
      },
    };

    try {
      await matrixService.sendPollResponse(roomId, content);
      // Optimistic: persist vote to Dexie so liveQuery picks it up
      const authStore = useAuthStore();
      const myAddr = authStore.address ?? "";
      try {
        const dbKit = chatStore.getDbKit();
        await dbKit.eventWriter.writePollVote(pollEventId, myAddr, optionId, true);
      } catch {
        // Dexie not ready — fall back to in-memory mutation
        const roomMsgs = chatStore.messages[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (pollMsg?.pollInfo) {
          for (const key of Object.keys(pollMsg.pollInfo.votes)) {
            pollMsg.pollInfo.votes[key] = pollMsg.pollInfo.votes[key].filter(v => v !== myAddr);
          }
          if (!pollMsg.pollInfo.votes[optionId]) pollMsg.pollInfo.votes[optionId] = [];
          pollMsg.pollInfo.votes[optionId].push(myAddr);
          pollMsg.pollInfo.myVote = optionId;
        }
      }
    } catch (e) {
      console.error("Failed to vote on poll:", e);
    }
  };

  /** End a poll */
  const endPoll = async (pollEventId: string) => {
    const chatStore = useChatStore();
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const content = {
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: pollEventId,
      },
      "org.matrix.msc1767.text": "Poll ended",
    };

    try {
      await matrixService.sendPollEnd(roomId, content);
      // Optimistic: persist poll end to Dexie so liveQuery picks it up
      const authStore = useAuthStore();
      const myAddr = authStore.address ?? "";
      try {
        const dbKit = chatStore.getDbKit();
        await dbKit.eventWriter.writePollEnd(pollEventId, myAddr);
      } catch {
        // Dexie not ready — fall back to in-memory mutation
        const roomMsgs = chatStore.messages[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (pollMsg?.pollInfo) {
          pollMsg.pollInfo.ended = true;
          pollMsg.pollInfo.endedBy = myAddr;
        }
      }
    } catch (e) {
      console.error("Failed to end poll:", e);
    }
  };

  /** Send a GIF message (fetches GIF from URL, uploads to Matrix as image) */
  const sendGif = async (gifUrl: string, info?: { w?: number; h?: number; title?: string }) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !gifUrl) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const w = info?.w ?? 300;
    const h = info?.h ?? 300;

    // Fetch the GIF as blob (before Dexie insert — we need the file)
    const response = await fetch(gifUrl);
    if (!response.ok) {
      console.error("Failed to fetch GIF:", response.status);
      return;
    }
    const blob = await response.blob();
    const file = new File([blob], "animation.gif", { type: "image/gif" });
    const localBlobUrl = URL.createObjectURL(file);

    // Dexie-first path
    if (isChatDbReady()) {
      try {
        const dbKit = getChatDb();
        const localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: info?.title || "GIF",
          type: MessageType.image,
          fileInfo: {
            name: file.name,
            type: file.type,
            size: file.size,
            url: localBlobUrl,
            w,
            h,
          },
          localBlobUrl,
          uploadProgress: 0,
        });

        // Async upload pipeline (with timeout to prevent infinite spinner)
        (async () => {
          try {
            await withTimeout((async () => {
              const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

              let fileToUpload: Blob = file;
              let secrets: Record<string, unknown> | undefined;

              if (roomCrypto?.canBeEncrypt()) {
                const encrypted = await roomCrypto.encryptFile(file);
                secrets = encrypted.secrets;
                fileToUpload = encrypted.file;
              }

              const url = await matrixService.uploadContent(fileToUpload, (progress) => {
                const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
                dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
              });

              const content: Record<string, unknown> = {
                body: info?.title || "GIF",
                msgtype: "m.image",
                url,
                info: {
                  w,
                  h,
                  mimetype: file.type,
                  size: file.size,
                  ...(secrets ? { secrets } : {}),
                },
              };

              const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);

              const serverFileInfo: FileInfo = {
                name: file.name,
                type: file.type,
                size: file.size,
                url,
                w,
                h,
                ...(secrets ? { secrets: secrets as FileInfo["secrets"] } : {}),
              };
              await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, serverFileInfo, roomId);

              invalidateDownloadCache(localMsg.clientId);
              setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
            })(), MEDIA_PIPELINE_TIMEOUT, "GIF upload");
          } catch (e) {
            console.error("Failed to send GIF (Dexie path):", e);
            const current = await dbKit.messages.getByClientId(localMsg.clientId);
            if (current && current.status !== "synced") {
              await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
                status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
                uploadProgress: undefined,
              });
            }
          }
        })();

        return;
      } catch (e) {
        console.warn("[use-messages] Dexie sendGif failed, falling back to legacy:", e);
      }
    }

    // Legacy path
    sendGifLegacy(file, roomId, localBlobUrl, w, h, info, matrixService);
  };

  /** Legacy sendGif — fallback when Dexie is not ready */
  const sendGifLegacy = async (
    file: File,
    roomId: string,
    localBlobUrl: string,
    w: number,
    h: number,
    info: { w?: number; h?: number; title?: string } | undefined,
    matrixService: ReturnType<typeof getMatrixClientService>,
  ) => {
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: info?.title || "GIF",
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.image,
      fileInfo: {
        name: file.name,
        type: file.type,
        size: file.size,
        url: localBlobUrl,
        w,
        h,
      },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      let fileToUpload: Blob = file;
      let secrets: Record<string, unknown> | undefined;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      const url = await matrixService.uploadContent(fileToUpload);

      const content: Record<string, unknown> = {
        body: info?.title || "GIF",
        msgtype: "m.image",
        url,
        info: {
          w,
          h,
          mimetype: file.type,
          size: file.size,
          ...(secrets ? { secrets } : {}),
        },
      };

      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send GIF:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Retry a failed media upload. Only works if the blob URL is still valid (same session). */
  const retryMediaUpload = async (message: Message) => {
    if (message.status !== MessageStatus.failed || !message.fileInfo) return;

    const roomId = message.roomId;
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;
    if (!isChatDbReady()) return;

    const dbKit = getChatDb();

    // Find the local message by clientId (_key is the stable clientId)
    const mKey = (message as Message & { _key?: string })._key;
    if (!mKey) return;

    const localMsg = await dbKit.messages.getByClientId(mKey);
    if (!localMsg) return;

    // Try to recover the blob from the still-alive blob URL
    const blobUrl = localMsg.localBlobUrl || localMsg.fileInfo?.url;
    if (!blobUrl) return;

    let file: File;
    try {
      const resp = await fetch(blobUrl);
      if (!resp.ok) throw new Error("Blob URL expired");
      const blob = await resp.blob();
      file = new File([blob], localMsg.fileInfo?.name || "file", {
        type: localMsg.fileInfo?.type || "application/octet-stream",
      });
    } catch {
      console.error("[retry] Blob URL no longer valid — user must re-send the file");
      return;
    }

    // Reset status to pending with progress
    await dbKit.db.messages.update(localMsg.localId!, {
      status: "pending" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
      uploadProgress: 0,
    });

    // Re-run upload pipeline (with abort support)
    const controller = registerUploadAbort(localMsg.clientId);
    const { signal } = controller;

    try {
      const checkAbort = () => {
        if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      };

      await withTimeout((async () => {
        // Phase 1: Encrypt
        checkAbort();
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
          .modify({ uploadPhase: "encrypting" });

        const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
        let fileToUpload: Blob = file;
        let secrets: Record<string, unknown> | undefined;

        if (roomCrypto?.canBeEncrypt()) {
          const encrypted = await roomCrypto.encryptFile(file);
          secrets = encrypted.secrets;
          fileToUpload = encrypted.file;
        }

        // Phase 2: Upload
        checkAbort();
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
          .modify({ uploadPhase: "uploading" });

        const url = await matrixService.uploadContent(fileToUpload, (progress) => {
          const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
          dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
        }, signal);

        // Phase 3: Send event
        checkAbort();
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId)
          .modify({ uploadPhase: "sending_event", uploadProgress: 100 });

        // Build event content based on message type
        const fi = localMsg.fileInfo!;
        let content: Record<string, unknown>;

        if (localMsg.type === "image") {
          content = {
            body: fi.caption || "Image",
            msgtype: "m.image",
            url,
            info: {
              w: fi.w, h: fi.h, mimetype: fi.type, size: fi.size,
              ...(secrets ? { secrets } : {}),
              ...(fi.caption ? { caption: fi.caption } : {}),
              ...(fi.captionAbove != null ? { captionAbove: fi.captionAbove } : {}),
            },
          };
        } else if (localMsg.type === "audio") {
          const intWaveform = fi.waveform?.map((v: number) => Math.round(v * 1024));
          content = {
            body: "Audio",
            msgtype: "m.audio",
            url,
            info: {
              mimetype: fi.type, size: Math.round(fi.size),
              duration: fi.duration ? Math.round(fi.duration * 1000) : undefined,
              waveform: intWaveform,
              ...(secrets ? { secrets } : {}),
            },
          };
        } else if (localMsg.type === "videoCircle") {
          content = {
            body: "Video message",
            msgtype: "m.video",
            url,
            info: {
              mimetype: fi.type, size: Math.round(fi.size), w: 480, h: 480,
              duration: fi.duration ? Math.round(fi.duration * 1000) : undefined,
              videoNote: true,
              ...(secrets ? { secrets } : {}),
            },
          };
        } else {
          // Generic file (m.file)
          const fileBody: Record<string, unknown> = {
            name: fi.name, type: fi.type, size: fi.size, url,
          };
          if (secrets) fileBody.secrets = secrets;
          content = { body: JSON.stringify(fileBody), msgtype: "m.file" };
        }

        const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);
        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          ...fi,
          url,
          secrets: secrets as FileInfo["secrets"],
        }, roomId);

        invalidateDownloadCache(localMsg.clientId);
        const blobToRevoke = localMsg.localBlobUrl;
        if (blobToRevoke) setTimeout(() => URL.revokeObjectURL(blobToRevoke), 5000);
      })(), MEDIA_PIPELINE_TIMEOUT, "Media retry upload");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        const blobUrl = localMsg.localBlobUrl || localMsg.fileInfo?.url;
        await handleUploadCancelled(dbKit, localMsg.clientId, blobUrl);
      } else {
        console.error("[retry] Upload failed again:", e);
        const current = await dbKit.messages.getByClientId(localMsg.clientId);
        if (current && current.status !== "synced") {
          await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
            status: "failed" as LocalMessageStatus,
            uploadProgress: undefined,
            uploadPhase: undefined,
          });
        }
      }
    } finally {
      unregisterUploadAbort(localMsg.clientId);
    }
  };

  /** Retry a failed text message by re-enqueuing it in SyncEngine */
  const retryMessage = async (message: Message) => {
    if (message.status !== MessageStatus.failed) return;
    if (!isChatDbReady()) return;

    const roomId = message.roomId;
    const mKey = (message as Message & { _key?: string })._key;
    if (!mKey) {
      console.warn("[retryMessage] No _key (clientId) — legacy-path message, retry not supported", { messageId: message.id });
      return;
    }

    const dbKit = getChatDb();
    const localMsg = await dbKit.messages.getByClientId(mKey);
    if (!localMsg) return;

    // Reset status to pending
    await dbKit.messages.updateStatus({ clientId: mKey }, "pending");

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) {
      console.error("[retryMessage] Matrix client still not ready", { roomId, clientId: mKey });
      await dbKit.messages.markFailed(mKey);
      return;
    }

    try {
      await dbKit.syncEngine.enqueue(
        "send_message",
        roomId,
        {
          content: localMsg.content,
          ...(localMsg.replyTo ? { replyToEventId: localMsg.replyTo.id } : {}),
          ...(localMsg.linkPreview ? {
            linkPreview: {
              url: localMsg.linkPreview.url,
              site_name: localMsg.linkPreview.siteName,
              title: localMsg.linkPreview.title,
              description: localMsg.linkPreview.description,
              image_url: localMsg.linkPreview.imageUrl,
              image_width: localMsg.linkPreview.imageWidth,
              image_height: localMsg.linkPreview.imageHeight,
            },
          } : {}),
        },
        mKey,
      );
    } catch (e) {
      console.error("[retryMessage] Failed to enqueue:", e);
      await dbKit.messages.markFailed(mKey);
    }
  };

  /** Cancel an in-flight or failed media upload */
  const cancelMediaUpload = async (message: Message): Promise<void> => {
    const mKey = (message as Message & { _key?: string })._key;
    if (!mKey) return;
    if (!isChatDbReady()) return;

    const dbKit = getChatDb();
    const localMsg = await dbKit.messages.getByClientId(mKey);
    if (!localMsg) return;

    // Can only cancel pending or failed uploads
    if (localMsg.status !== "pending" && localMsg.status !== "failed") return;

    // Abort HTTP request if in-flight
    abortUpload(mKey);

    // Force cleanup (in case abort didn't trigger catch — e.g. between phases)
    await handleUploadCancelled(dbKit, mKey, localMsg.localBlobUrl);
  };

  return {
    cancelMediaUpload,
    deleteMessage,
    drainOfflineQueue,
    editMessage,
    endPoll,
    forwardMessage,
    loadMessages,
    retryMediaUpload,
    retryMessage,
    sendAudio,
    sendFile,
    sendGif,
    sendImage,
    sendMessage,
    sendPoll,
    sendReply,
    sendVideoCircle,
    sendTransferMessage,
    setTyping,
    toggleReaction,
    votePoll,
  };
}
