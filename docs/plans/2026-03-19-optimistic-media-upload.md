# Optimistic Media Upload — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Media messages (image, file, audio, video, GIF) appear instantly in chat UI with local blob preview, upload progress, and retry on failure — same as text messages do today.

**Architecture:** Switch all media send functions from legacy `chatStore.addMessage()` (invisible when Dexie active) to `dbKit.messages.createLocal()` (Dexie-first, liveQuery-driven). Upload runs inline async with progress callback updating Dexie. `useFileDownload` already handles blob URLs transparently.

**Tech Stack:** Vue 3, Pinia, Dexie.js (IndexedDB), matrix-js-sdk-bastyon

**Design doc:** `docs/plans/2026-03-19-optimistic-media-upload-design.md`

---

### Task 1: Dexie Schema Migration v7 — add media upload fields to LocalMessage

**Files:**
- Modify: `src/shared/lib/local-db/schema.ts:84-121` (LocalMessage interface)
- Modify: `src/shared/lib/local-db/schema.ts:410-457` (add version 7)

**Step 1: Add fields to LocalMessage interface**

In `schema.ts`, add two optional fields to `LocalMessage` after line 120 (`deletedAt?: number`):

```typescript
  /** Upload progress 0-100 (only during media upload) */
  uploadProgress?: number;
  /** Local blob: URL for instant media preview before upload completes */
  localBlobUrl?: string;
```

**Step 2: Add Dexie version 7**

After the version 6 block (line 456), add version 7. No index changes needed — these are non-indexed optional fields:

```typescript
    // Version 7: add uploadProgress and localBlobUrl to LocalMessage (no index changes)
    this.version(7).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    });
```

**Step 3: Verify app starts**

Run: `npx vite build 2>&1 | tail -20`
Expected: Build succeeds (no type errors from schema changes).

**Step 4: Commit**

```bash
git add src/shared/lib/local-db/schema.ts
git commit -m "feat: Dexie v7 migration — add uploadProgress and localBlobUrl to LocalMessage"
```

---

### Task 2: Add uploadProgress to Message interface

**Files:**
- Modify: `src/entities/chat/model/types.ts:70-109` (Message interface)

**Step 1: Add uploadProgress field**

After `linkPreview?: LinkPreview;` (line 100), add:

```typescript
  /** Upload progress 0-100 (only during media upload, undefined when not uploading) */
  uploadProgress?: number;
```

**Step 2: Commit**

```bash
git add src/entities/chat/model/types.ts
git commit -m "feat: add uploadProgress to Message interface"
```

---

### Task 3: Update localToMessage mapper

**Files:**
- Modify: `src/shared/lib/local-db/mappers.ts:9-42` (localToMessage function)

**Step 1: Add localBlobUrl and uploadProgress to mapper**

The mapper needs to:
1. Use `localBlobUrl` as `fileInfo.url` when present (for instant preview)
2. Pass through `uploadProgress`

Replace the `fileInfo` line (line 30) and add uploadProgress:

```typescript
    fileInfo: isDeleted ? undefined : (local.fileInfo ? {
      ...local.fileInfo,
      // Use local blob URL for instant preview during upload, fall back to server URL
      url: local.localBlobUrl || local.fileInfo.url,
    } : undefined),
```

After `systemMeta: local.systemMeta,` (line 41), add:

```typescript
    uploadProgress: local.uploadProgress,
```

**Step 2: Commit**

```bash
git add src/shared/lib/local-db/mappers.ts
git commit -m "feat: mapper passes localBlobUrl and uploadProgress to UI"
```

---

### Task 4: Add updateUploadProgress to MessageRepository

**Files:**
- Modify: `src/shared/lib/local-db/message-repository.ts`

**Step 1: Add updateUploadProgress method**

After the `confirmSent` method (line 305), add:

```typescript
  /** Update upload progress for a media message */
  async updateUploadProgress(clientId: string, progress: number): Promise<void> {
    await this.db.messages
      .where("clientId")
      .equals(clientId)
      .modify({ uploadProgress: progress });
  }

  /** Mark upload as complete — clear upload fields, update fileInfo URL */
  async confirmMediaSent(
    clientId: string,
    eventId: string,
    serverFileInfo: LocalMessage["fileInfo"],
  ): Promise<void> {
    await this.db.messages
      .where("clientId")
      .equals(clientId)
      .modify({
        eventId,
        status: "synced" as LocalMessageStatus,
        serverTs: Date.now(),
        fileInfo: serverFileInfo,
        uploadProgress: undefined,
        localBlobUrl: undefined,
      });
  }
```

**Step 2: Commit**

```bash
git add src/shared/lib/local-db/message-repository.ts
git commit -m "feat: add updateUploadProgress and confirmMediaSent to MessageRepository"
```

---

### Task 5: Rewrite sendImage to Dexie-first path

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:257-328` (sendImage function)

**Step 1: Replace sendImage implementation**

Replace the entire `sendImage` function body with the Dexie-first pipeline:

```typescript
  const sendImage = async (file: File, options: { caption?: string; captionAbove?: boolean } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const dimensions = await getImageDimensions(file);
    const localBlobUrl = URL.createObjectURL(file);

    // --- Dexie-first path: instant insert → async upload ---
    if (isChatDbReady()) {
      const dbKit = getChatDb();
      let localMsg: import("@/shared/lib/local-db/schema").LocalMessage;
      try {
        localMsg = await dbKit.messages.createLocal({
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
        });
        // Set localBlobUrl on the Dexie row (createLocal doesn't know about it)
        await dbKit.db.messages.update(localMsg.localId!, {
          localBlobUrl,
          uploadProgress: 0,
        });
      } catch (e) {
        console.warn("[use-messages] Dexie createLocal failed for image, falling back:", e);
        URL.revokeObjectURL(localBlobUrl);
        // Fall through to legacy path below
        return sendImageLegacy(file, options, localBlobUrl);
      }

      // Async upload pipeline (non-blocking — message already visible in UI)
      try {
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

        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          name: file.name,
          type: file.type,
          size: file.size,
          url,
          w: dimensions.w,
          h: dimensions.h,
          secrets: secrets as FileInfo["secrets"],
          caption: options.caption,
          captionAbove: options.captionAbove,
        });

        // Revoke blob URL after UI has time to switch to server version
        setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
      } catch (e) {
        console.error("Failed to upload/send image:", e);
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
          status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
          uploadProgress: undefined,
        });
      }
      return;
    }

    // Legacy fallback (Dexie not ready)
    return sendImageLegacy(file, options, localBlobUrl);
  };
```

**Step 2: Extract legacy sendImage as a private helper**

Add this before the `return` statement of `useMessages()`:

```typescript
  /** Legacy sendImage — used when Dexie is not initialized */
  const sendImageLegacy = async (file: File, options: { caption?: string; captionAbove?: boolean }, localBlobUrl: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const dimensions = await getImageDimensions(file);
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
        name: file.name, type: file.type, size: file.size, url: localBlobUrl,
        w: dimensions.w, h: dimensions.h, caption: options.caption, captionAbove: options.captionAbove,
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
        body: options.caption || "Image", msgtype: "m.image", url,
        info: { w: dimensions.w, h: dimensions.h, mimetype: file.type, size: file.size,
          ...(secrets ? { secrets } : {}),
          ...(options.caption ? { caption: options.caption } : {}),
          ...(options.captionAbove != null ? { captionAbove: options.captionAbove } : {}),
        },
      };
      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      else chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
    } catch (e) {
      console.error("Failed to send image:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };
```

**Step 3: Verify build**

Run: `npx vite build 2>&1 | tail -20`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat: sendImage uses Dexie-first optimistic insert with upload progress"
```

---

### Task 6: Rewrite sendFile to Dexie-first path

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:181-254` (sendFile function)

**Step 1: Replace sendFile with Dexie-first pipeline**

Same pattern as sendImage but with `msgtype: "m.file"` and JSON body format:

```typescript
  const sendFile = async (file: File) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    let msgType = MessageType.file;
    if (file.type.startsWith("image/")) msgType = MessageType.image;
    else if (file.type.startsWith("video/")) msgType = MessageType.video;
    else if (file.type.startsWith("audio/")) msgType = MessageType.audio;

    const localBlobUrl = URL.createObjectURL(file);

    if (isChatDbReady()) {
      const dbKit = getChatDb();
      let localMsg: import("@/shared/lib/local-db/schema").LocalMessage;
      try {
        localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: file.name,
          type: msgType,
          fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl },
        });
        await dbKit.db.messages.update(localMsg.localId!, { localBlobUrl, uploadProgress: 0 });
      } catch (e) {
        console.warn("[use-messages] Dexie createLocal failed for file:", e);
        URL.revokeObjectURL(localBlobUrl);
        return sendFileLegacy(file, localBlobUrl);
      }

      try {
        const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fileInfo: Record<string, any> = { name: file.name, type: file.type, size: file.size };
        let fileToUpload: Blob = file;

        if (roomCrypto?.canBeEncrypt()) {
          const encrypted = await roomCrypto.encryptFile(file);
          fileInfo.secrets = encrypted.secrets;
          fileToUpload = encrypted.file;
        }

        const url = await matrixService.uploadContent(fileToUpload, (progress) => {
          const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
          dbKit.messages.updateUploadProgress(localMsg.clientId, percent);
        });
        fileInfo.url = url;

        const body = JSON.stringify(fileInfo);
        const serverEventId = await matrixService.sendEncryptedText(roomId, { body, msgtype: "m.file" }, localMsg.clientId);

        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          name: file.name, type: file.type, size: file.size, url,
          secrets: fileInfo.secrets,
        });
        setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
      } catch (e) {
        console.error("Failed to upload/send file:", e);
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
          status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
          uploadProgress: undefined,
        });
      }
      return;
    }

    return sendFileLegacy(file, localBlobUrl);
  };
```

**Step 2: Extract sendFileLegacy**

```typescript
  const sendFileLegacy = async (file: File, localBlobUrl: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    let msgType = MessageType.file;
    if (file.type.startsWith("image/")) msgType = MessageType.image;
    else if (file.type.startsWith("video/")) msgType = MessageType.video;
    else if (file.type.startsWith("audio/")) msgType = MessageType.audio;

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId, roomId, senderId: authStore.address ?? "", content: file.name,
      timestamp: Date.now(), status: MessageStatus.sending, type: msgType,
      fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl },
    };
    chatStore.addMessage(roomId, message);

    try {
      const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileInfo: Record<string, any> = { name: file.name, type: file.type, size: file.size };
      let fileToUpload: Blob = file;
      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await roomCrypto.encryptFile(file);
        fileInfo.secrets = encrypted.secrets;
        fileToUpload = encrypted.file;
      }
      const url = await matrixService.uploadContent(fileToUpload);
      fileInfo.url = url;
      const body = JSON.stringify(fileInfo);
      const serverEventId = await matrixService.sendEncryptedText(roomId, { body, msgtype: "m.file" });
      if (serverEventId) chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      else chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
    } catch (e) {
      console.error("Failed to send file:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat: sendFile uses Dexie-first optimistic insert with upload progress"
```

---

### Task 7: Rewrite sendAudio to Dexie-first path

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:331-401` (sendAudio function)

**Step 1: Replace sendAudio with Dexie-first pipeline**

```typescript
  const sendAudio = async (file: File, options: { duration?: number; waveform?: number[] } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const localBlobUrl = URL.createObjectURL(file);

    if (isChatDbReady()) {
      const dbKit = getChatDb();
      let localMsg: import("@/shared/lib/local-db/schema").LocalMessage;
      try {
        localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: "Audio",
          type: MessageType.audio,
          fileInfo: {
            name: file.name, type: file.type, size: file.size, url: localBlobUrl,
            duration: options.duration, waveform: options.waveform,
          },
        });
        await dbKit.db.messages.update(localMsg.localId!, { localBlobUrl, uploadProgress: 0 });
      } catch (e) {
        console.warn("[use-messages] Dexie createLocal failed for audio:", e);
        URL.revokeObjectURL(localBlobUrl);
        return sendAudioLegacy(file, options, localBlobUrl);
      }

      try {
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

        const intWaveform = options.waveform?.map((v: number) => Math.round(v * 1024));
        const content: Record<string, unknown> = {
          body: "Audio", msgtype: "m.audio", url,
          info: {
            mimetype: file.type, size: Math.round(file.size),
            duration: options.duration ? Math.round(options.duration * 1000) : undefined,
            waveform: intWaveform,
            ...(secrets ? { secrets } : {}),
          },
        };

        const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);
        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          name: file.name, type: file.type, size: file.size, url,
          secrets: secrets as FileInfo["secrets"],
          duration: options.duration, waveform: options.waveform,
        });
        setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
      } catch (e) {
        console.error("Failed to upload/send audio:", e);
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
          status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
          uploadProgress: undefined,
        });
      }
      return;
    }

    return sendAudioLegacy(file, options, localBlobUrl);
  };
```

**Step 2: Extract sendAudioLegacy**

Same as current sendAudio body but accepting `localBlobUrl` parameter instead of creating it.

```typescript
  const sendAudioLegacy = async (file: File, options: { duration?: number; waveform?: number[] }, localBlobUrl: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId, roomId, senderId: authStore.address ?? "", content: "Audio",
      timestamp: Date.now(), status: MessageStatus.sending, type: MessageType.audio,
      fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl,
        duration: options.duration, waveform: options.waveform },
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
        body: "Audio", msgtype: "m.audio", url,
        info: { mimetype: file.type, size: Math.round(file.size),
          duration: options.duration ? Math.round(options.duration * 1000) : undefined,
          waveform: intWaveform, ...(secrets ? { secrets } : {}) },
      };
      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      else chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
    } catch (e) {
      console.error("Failed to send audio:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat: sendAudio uses Dexie-first optimistic insert with upload progress"
```

---

### Task 8: Rewrite sendVideoCircle to Dexie-first path

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:404-473` (sendVideoCircle function)

**Step 1: Replace sendVideoCircle with Dexie-first pipeline**

```typescript
  const sendVideoCircle = async (file: File, options: { duration?: number } = {}) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !file) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const localBlobUrl = URL.createObjectURL(file);

    if (isChatDbReady()) {
      const dbKit = getChatDb();
      let localMsg: import("@/shared/lib/local-db/schema").LocalMessage;
      try {
        localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: "Video message",
          type: MessageType.videoCircle,
          fileInfo: {
            name: file.name, type: file.type, size: file.size, url: localBlobUrl,
            w: 480, h: 480, duration: options.duration, videoNote: true,
          },
        });
        await dbKit.db.messages.update(localMsg.localId!, { localBlobUrl, uploadProgress: 0 });
      } catch (e) {
        console.warn("[use-messages] Dexie createLocal failed for video circle:", e);
        URL.revokeObjectURL(localBlobUrl);
        return sendVideoCircleLegacy(file, options, localBlobUrl);
      }

      try {
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
          body: "Video message", msgtype: "m.video", url,
          info: {
            mimetype: file.type, size: Math.round(file.size), w: 480, h: 480,
            duration: options.duration ? Math.round(options.duration * 1000) : undefined,
            videoNote: true, ...(secrets ? { secrets } : {}),
          },
        };

        const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);
        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          name: file.name, type: file.type, size: file.size, url,
          w: 480, h: 480, duration: options.duration, videoNote: true,
          secrets: secrets as FileInfo["secrets"],
        });
        setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
      } catch (e) {
        console.error("Failed to upload/send video circle:", e);
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
          status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
          uploadProgress: undefined,
        });
      }
      return;
    }

    return sendVideoCircleLegacy(file, options, localBlobUrl);
  };
```

**Step 2: Extract sendVideoCircleLegacy** (same pattern as current body)

```typescript
  const sendVideoCircleLegacy = async (file: File, options: { duration?: number }, localBlobUrl: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId, roomId, senderId: authStore.address ?? "", content: "Video message",
      timestamp: Date.now(), status: MessageStatus.sending, type: MessageType.videoCircle,
      fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl,
        w: 480, h: 480, duration: options.duration, videoNote: true },
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
        body: "Video message", msgtype: "m.video", url,
        info: { mimetype: file.type, size: Math.round(file.size), w: 480, h: 480,
          duration: options.duration ? Math.round(options.duration * 1000) : undefined,
          videoNote: true, ...(secrets ? { secrets } : {}) },
      };
      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      else chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
    } catch (e) {
      console.error("Failed to send video circle:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat: sendVideoCircle uses Dexie-first optimistic insert with upload progress"
```

---

### Task 9: Rewrite sendGif to Dexie-first path

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:1092-1170` (sendGif function)

**Step 1: Replace sendGif with Dexie-first pipeline**

Same as sendImage pattern. Note: GIF fetch from URL happens before the Dexie insert (it's a remote URL, not a local file), so the user won't see the message until the GIF blob is fetched. This is acceptable since GIF fetch is fast (typically <1s).

```typescript
  const sendGif = async (gifUrl: string, info?: { w?: number; h?: number; title?: string }) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId || !gifUrl) return;

    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const w = info?.w ?? 300;
    const h = info?.h ?? 300;

    const response = await fetch(gifUrl);
    if (!response.ok) { console.error("Failed to fetch GIF:", response.status); return; }
    const blob = await response.blob();
    const file = new File([blob], "animation.gif", { type: "image/gif" });

    const localBlobUrl = URL.createObjectURL(file);

    if (isChatDbReady()) {
      const dbKit = getChatDb();
      let localMsg: import("@/shared/lib/local-db/schema").LocalMessage;
      try {
        localMsg = await dbKit.messages.createLocal({
          roomId,
          senderId: authStore.address ?? "",
          content: info?.title || "GIF",
          type: MessageType.image,
          fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl, w, h },
        });
        await dbKit.db.messages.update(localMsg.localId!, { localBlobUrl, uploadProgress: 0 });
      } catch (e) {
        console.warn("[use-messages] Dexie createLocal failed for GIF:", e);
        URL.revokeObjectURL(localBlobUrl);
        return sendGifLegacy(file, info, localBlobUrl);
      }

      try {
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
          body: info?.title || "GIF", msgtype: "m.image", url,
          info: { w, h, mimetype: file.type, size: file.size, ...(secrets ? { secrets } : {}) },
        };

        const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);
        await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
          name: file.name, type: file.type, size: file.size, url, w, h,
          secrets: secrets as FileInfo["secrets"],
        });
        setTimeout(() => URL.revokeObjectURL(localBlobUrl), 5000);
      } catch (e) {
        console.error("Failed to upload/send GIF:", e);
        await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
          status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
          uploadProgress: undefined,
        });
      }
      return;
    }

    return sendGifLegacy(file, info, localBlobUrl);
  };
```

**Step 2: Extract sendGifLegacy**

```typescript
  const sendGifLegacy = async (file: File, info: { w?: number; h?: number; title?: string } | undefined, localBlobUrl: string) => {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const matrixService = getMatrixClientService();

    const w = info?.w ?? 300;
    const h = info?.h ?? 300;
    const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message: Message = {
      id: tempId, roomId, senderId: authStore.address ?? "", content: info?.title || "GIF",
      timestamp: Date.now(), status: MessageStatus.sending, type: MessageType.image,
      fileInfo: { name: file.name, type: file.type, size: file.size, url: localBlobUrl, w, h },
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
        body: info?.title || "GIF", msgtype: "m.image", url,
        info: { w, h, mimetype: file.type, size: file.size, ...(secrets ? { secrets } : {}) },
      };
      const serverEventId = await matrixService.sendEncryptedText(roomId, content);
      if (serverEventId) chatStore.updateMessageIdAndStatus(roomId, tempId, serverEventId, MessageStatus.sent);
      else chatStore.updateMessageStatus(roomId, tempId, MessageStatus.sent);
    } catch (e) {
      console.error("Failed to send GIF:", e);
      chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
    }
  };
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat: sendGif uses Dexie-first optimistic insert with upload progress"
```

---

### Task 10: Update MessageBubble — circular upload progress overlay + retry button

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue`

**Step 1: Add `isUploading` and `isFailed` computed properties**

Near the existing `isSending` computed (line 180):

```typescript
const isUploading = computed(() =>
  props.message.status === MessageStatus.sending &&
  props.message.uploadProgress !== undefined
);
const isFailed = computed(() => props.message.status === MessageStatus.failed);
```

**Step 2: Replace image sending overlay with circular progress**

Replace the sending overlay block (lines 396-398):

```html
          <!-- Upload progress overlay -->
          <div v-if="isUploading" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <svg class="h-14 w-14" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2.5"
                :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
            </svg>
            <span class="absolute text-sm font-medium text-white">{{ message.uploadProgress }}%</span>
          </div>
          <!-- Sending spinner (no progress info) -->
          <div v-else-if="isSending" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <div class="h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />
          </div>
          <!-- Failed overlay with retry -->
          <div v-if="isFailed && hasFileInfo" class="absolute inset-0 flex items-center justify-center bg-black/40">
            <button class="flex flex-col items-center gap-1 text-white" @click.stop="emit('retryMedia', message)">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span class="text-xs font-medium">{{ t('message.retry') }}</span>
            </button>
          </div>
```

**Step 3: Add `retryMedia` emit**

In the component's `defineEmits`, add:

```typescript
retryMedia: [message: Message];
```

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageBubble.vue
git commit -m "feat: circular upload progress and retry button in MessageBubble"
```

---

### Task 11: Wire retry handler in MessageList / use-messages

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts` (add retryMediaUpload)
- Modify: `src/features/messaging/ui/MessageList.vue` (handle retryMedia emit)

**Step 1: Add retryMediaUpload to use-messages**

This function re-triggers the upload for a failed media message. Since we don't persist the blob in IndexedDB (Approach A), retry needs the original file. We store blob URLs — if the blob URL is still alive (same session), we can fetch it. Otherwise, user must re-send.

```typescript
  /** Retry a failed media upload. Only works if the blob URL is still valid (same session). */
  const retryMediaUpload = async (message: Message) => {
    if (message.status !== MessageStatus.failed || !message.fileInfo) return;

    const roomId = message.roomId;
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;
    if (!isChatDbReady()) return;

    const dbKit = getChatDb();

    // Find the local message by clientId (_key)
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
      file = new File([blob], localMsg.fileInfo?.name || "file", { type: localMsg.fileInfo?.type || "application/octet-stream" });
    } catch {
      console.error("[retry] Blob URL no longer valid — user must re-send the file");
      // Could show a toast here
      return;
    }

    // Reset status to uploading
    await dbKit.db.messages.update(localMsg.localId!, {
      status: "pending" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
      uploadProgress: 0,
    });

    // Re-run upload pipeline
    try {
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

      // Build event content based on message type
      let content: Record<string, unknown>;
      const fi = localMsg.fileInfo!;

      if (localMsg.type === "image") {
        content = {
          body: fi.caption || "Image", msgtype: "m.image", url,
          info: { w: fi.w, h: fi.h, mimetype: fi.type, size: fi.size,
            ...(secrets ? { secrets } : {}),
            ...(fi.caption ? { caption: fi.caption } : {}),
            ...(fi.captionAbove != null ? { captionAbove: fi.captionAbove } : {}),
          },
        };
      } else if (localMsg.type === "audio") {
        const intWaveform = fi.waveform?.map((v: number) => Math.round(v * 1024));
        content = {
          body: "Audio", msgtype: "m.audio", url,
          info: { mimetype: fi.type, size: Math.round(fi.size),
            duration: fi.duration ? Math.round(fi.duration * 1000) : undefined,
            waveform: intWaveform, ...(secrets ? { secrets } : {}) },
        };
      } else if (localMsg.type === "videoCircle") {
        content = {
          body: "Video message", msgtype: "m.video", url,
          info: { mimetype: fi.type, size: Math.round(fi.size), w: 480, h: 480,
            duration: fi.duration ? Math.round(fi.duration * 1000) : undefined,
            videoNote: true, ...(secrets ? { secrets } : {}) },
        };
      } else {
        // Generic file
        const fileBody: Record<string, unknown> = { name: fi.name, type: fi.type, size: fi.size, url };
        if (secrets) (fileBody as Record<string, unknown>).secrets = secrets;
        content = { body: JSON.stringify(fileBody), msgtype: "m.file" };
      }

      const serverEventId = await matrixService.sendEncryptedText(roomId, content, localMsg.clientId);
      await dbKit.messages.confirmMediaSent(localMsg.clientId, serverEventId, {
        ...fi, url, secrets: secrets as FileInfo["secrets"],
      });

      const blobToRevoke = localMsg.localBlobUrl;
      if (blobToRevoke) setTimeout(() => URL.revokeObjectURL(blobToRevoke), 5000);
    } catch (e) {
      console.error("[retry] Upload failed again:", e);
      await dbKit.db.messages.where("clientId").equals(localMsg.clientId).modify({
        status: "failed" as import("@/shared/lib/local-db/schema").LocalMessageStatus,
        uploadProgress: undefined,
      });
    }
  };
```

Add `retryMediaUpload` to the return object.

**Step 2: Handle retryMedia event in MessageList**

In `MessageList.vue`, where `MessageBubble` is rendered, add the event handler:

```html
@retry-media="retryMediaUpload"
```

And destructure `retryMediaUpload` from `useMessages()` at the top of the setup.

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts src/features/messaging/ui/MessageList.vue
git commit -m "feat: retry handler for failed media uploads"
```

---

### Task 12: Add i18n key for retry button

**Files:**
- Modify: locale files (en, ru) for `message.retry` key

**Step 1: Find and update locale files**

Search for existing `message.deleted` key to find the locale file locations, then add `message.retry`:

```json
"retry": "Retry"
```

Russian:
```json
"retry": "Повторить"
```

**Step 2: Commit**

```bash
git add -A -- src/shared/i18n/ src/shared/locales/
git commit -m "feat: add i18n key for media retry button"
```

---

### Task 13: Verify build and manual smoke test

**Step 1: Build**

Run: `npx vite build 2>&1 | tail -30`
Expected: Build succeeds with no errors.

**Step 2: Manual smoke test checklist**

- [ ] Send an image — appears instantly with blob preview and progress circle
- [ ] Send a file — appears instantly with file name and progress
- [ ] Send a voice message — appears instantly with waveform and progress
- [ ] Send a video circle — appears instantly with progress
- [ ] Send a GIF — appears after GIF fetch (< 1s) with progress
- [ ] Disconnect network → send image → see "failed" → reconnect → tap Retry → uploads
- [ ] Room preview in sidebar shows "[photo]" / "[file]" immediately
- [ ] After upload completes, progress overlay disappears
- [ ] Blob URL is revoked (check DevTools blob: URLs count)

**Step 3: Final commit if any fixups needed**

---

## Dependency Graph

```
Task 1 (schema) ──┐
Task 2 (types)  ──┤
Task 3 (mapper) ──┼── Task 5 (sendImage)
Task 4 (repo)   ──┘   Task 6 (sendFile)
                       Task 7 (sendAudio)
                       Task 8 (sendVideoCircle)
                       Task 9 (sendGif)
                           │
                       Task 10 (MessageBubble UI)
                           │
                       Task 11 (retry handler)
                           │
                       Task 12 (i18n)
                           │
                       Task 13 (verify)
```

Tasks 1-4 are foundational (can be done in parallel).
Tasks 5-9 are independent of each other (can be done in parallel).
Tasks 10-13 are sequential.
