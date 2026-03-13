import { useChatStore, MessageStatus, MessageType } from "@/entities/chat";
import type { FileInfo, Message, LinkPreview } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { getMatrixClientService } from "@/entities/matrix";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { useConnectivity } from "@/shared/lib/connectivity";
import { enqueue, dequeue, getQueue } from "@/shared/lib/offline-queue";
import type { QueuedMessage } from "@/shared/lib/offline-queue";

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
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    });
  };

  const sendMessage = async (content: string, linkPreview?: LinkPreview) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !content.trim()) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const trimmed = content.trim();

    // Optimistic message
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: trimmed,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.text,
      ...(linkPreview ? { linkPreview } : {}),
    };
    chatStore.addMessage(roomId, message);

    // If offline, queue the message for later
    if (!isOnline.value) {
      enqueue({ id: tempId, roomId, content: trimmed, timestamp: Date.now() });
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      return;
    }

    try {
      // Check if room has encryption
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

      let serverEventId: string;
      if (roomCrypto?.canBeEncrypt()) {
        // Send encrypted
        const encrypted = await roomCrypto.encryptEvent(trimmed);
        if (linkPreview) {
          (encrypted as Record<string, unknown>).url_preview = {
            url: linkPreview.url,
            site_name: linkPreview.siteName,
            title: linkPreview.title,
            description: linkPreview.description,
            image_url: linkPreview.imageUrl,
            image_width: linkPreview.imageWidth,
            image_height: linkPreview.imageHeight,
          };
        }
        serverEventId = await matrixService.sendEncryptedText(roomId, encrypted);
      } else {
        // Send plaintext
        if (linkPreview) {
          const content: Record<string, unknown> = {
            body: trimmed,
            msgtype: "m.text",
            url_preview: {
              url: linkPreview.url,
              site_name: linkPreview.siteName,
              title: linkPreview.title,
              description: linkPreview.description,
              image_url: linkPreview.imageUrl,
              image_width: linkPreview.imageWidth,
              image_height: linkPreview.imageHeight,
            },
          };
          serverEventId = await matrixService.sendEncryptedText(roomId, content);
        } else {
          serverEventId = await matrixService.sendText(roomId, trimmed);
        }
      }

      // Replace temp ID with server event_id so read receipts can match
      if (serverEventId) {
        chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      } else {
        chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
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

  // Listen for online event to drain queue
  if (typeof window !== "undefined") {
    window.addEventListener("online", drainOfflineQueue);
  }

  /** Send a file/image/video/audio message */
  const sendFile = async (file: File) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    // Determine message type from MIME
    let msgType = MessageType.file;
    if (file.type.startsWith("image/")) msgType = MessageType.image;
    else if (file.type.startsWith("video/")) msgType = MessageType.video;
    else if (file.type.startsWith("audio/")) msgType = MessageType.audio;

    // Optimistic message
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const localBlobUrl = URL.createObjectURL(file);
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
        type: file.type,
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
        type: file.type,
        size: file.size,
      };

      let fileToUpload: Blob = file;

      // Encrypt the file if room has encryption
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        fileInfo.secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }

      // Upload to Matrix server
      const url = await matrixService.uploadContent(fileToUpload);
      fileInfo.url = url;

      // Send as m.file event with body = JSON of fileInfo
      // (This is the bastyon-chat format for all file types)
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

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const localBlobUrl = URL.createObjectURL(file);
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

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    // Create a local blob URL so VoiceMessage can play immediately (before upload completes)
    const localBlobUrl = URL.createObjectURL(file);
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

      // Matrix server rejects float values — ensure all numbers are integers.
      // Waveform: convert 0..1 floats to 0..1024 integers (Matrix spec range).
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

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const localBlobUrl = URL.createObjectURL(file);
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
    await chatStore.loadRoomMessages(roomId);
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
   *  - Includes optimistic local update for instant feedback. */
  const toggleReaction = async (messageId: string, emoji: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const roomMessages = chatStore.messages[roomId] ?? [];
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
        // Send new reaction
        chatStore.optimisticAddReaction(roomId, messageId, emoji, myAddress);
        const realEventId = await matrixService.sendReaction(roomId, messageId, emoji);
        // Store the server-assigned event ID so redaction works later
        chatStore.setReactionEventId(roomId, messageId, emoji, realEventId);
      }
    } catch (e) {
      console.error("Failed to toggle reaction:", e);
      await chatStore.loadRoomMessages(roomId);
    }
  };

  /** Send message with reply context */
  const sendReply = async (content: string, linkPreview?: LinkPreview) => {
    const roomId = chatStore.activeRoomId;
    const replyTo = chatStore.replyingTo;
    if (!roomId || !content.trim() || !replyTo) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const trimmed = content.trim();

    // Optimistic message
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: trimmed,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.text,
      replyTo: {
        id: replyTo.id,
        senderId: replyTo.senderId,
        content: replyTo.content,
        type: replyTo.type,
      },
      ...(linkPreview ? { linkPreview } : {}),
    };
    chatStore.addMessage(roomId, message);
    chatStore.replyingTo = null;

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

      if (linkPreview) {
        msgContent.url_preview = {
          url: linkPreview.url,
          site_name: linkPreview.siteName,
          title: linkPreview.title,
          description: linkPreview.description,
          image_url: linkPreview.imageUrl,
          image_width: linkPreview.imageWidth,
          image_height: linkPreview.imageHeight,
        };
      }

      let serverEventId: string;
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptEvent(trimmed);
        // Merge reply relation and url_preview into encrypted content
        const encContent: Record<string, unknown> = { ...encrypted, "m.relates_to": msgContent["m.relates_to"] };
        if (msgContent.url_preview) encContent.url_preview = msgContent.url_preview;
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
      console.error("Failed to send reply:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };

  /** Edit an existing message (Matrix m.replace relation) */
  const editMessage = async (messageId: string, newContent: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !newContent.trim()) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const trimmed = newContent.trim();

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
   *  Embeds transfer metadata as JSON in the body, then encrypts with Pcrypto
   *  like any regular message so it goes through the same send/receive pipeline. */
  const sendTransferMessage = async (
    txId: string,
    amount: number,
    receiverAddress: string,
    message?: string,
  ) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    // Encode transfer data as JSON body — parseSingleEvent will detect the _transfer marker
    const transferBody = JSON.stringify({
      _transfer: true,
      txId,
      amount,
      from: authStore.address ?? "",
      to: receiverAddress,
      message: message || undefined,
    });

    // Optimistic local message
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const optimistic: Message = {
      id: tempId,
      roomId,
      senderId: authStore.address ?? "",
      content: message || `Sent ${amount} PKOIN`,
      timestamp: Date.now(),
      status: MessageStatus.sending,
      type: MessageType.transfer,
      transferInfo: {
        txId,
        amount,
        from: authStore.address ?? "",
        to: receiverAddress,
        message: message || undefined,
      },
    };
    chatStore.addMessage(roomId, optimistic);

    try {
      // Encrypt with Pcrypto like regular messages
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
      // Optimistic: update vote locally
      const roomMsgs = chatStore.messages[roomId];
      const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
      if (pollMsg?.pollInfo) {
        const authStore = useAuthStore();
        const myAddr = authStore.address ?? "";
        // Remove old vote
        for (const key of Object.keys(pollMsg.pollInfo.votes)) {
          pollMsg.pollInfo.votes[key] = pollMsg.pollInfo.votes[key].filter(v => v !== myAddr);
        }
        // Add new vote
        if (!pollMsg.pollInfo.votes[optionId]) pollMsg.pollInfo.votes[optionId] = [];
        pollMsg.pollInfo.votes[optionId].push(myAddr);
        pollMsg.pollInfo.myVote = optionId;
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
      // Optimistic: mark as ended
      const roomMsgs = chatStore.messages[roomId];
      const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
      if (pollMsg?.pollInfo) {
        const authStore = useAuthStore();
        pollMsg.pollInfo.ended = true;
        pollMsg.pollInfo.endedBy = authStore.address ?? "";
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

    // Fetch the GIF as blob
    const response = await fetch(gifUrl);
    if (!response.ok) {
      console.error("Failed to fetch GIF:", response.status);
      return;
    }
    const blob = await response.blob();
    const file = new File([blob], "animation.gif", { type: "image/gif" });

    // Optimistic message
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const localBlobUrl = URL.createObjectURL(file);
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

  return {
    deleteMessage,
    drainOfflineQueue,
    editMessage,
    endPoll,
    forwardMessage,
    loadMessages,
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
