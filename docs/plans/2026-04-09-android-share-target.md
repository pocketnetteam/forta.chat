# Android Share Target Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Forta Chat appear in Android's Share Sheet so users can share text, links, images, and files from other apps into any chat.

**Architecture:** `@capgo/capacitor-share-target` plugin receives Android SEND intents via a listener. A new `share-target.ts` service maps incoming data into a `ForwardingMessage` and triggers the existing ForwardPicker UX. Deferred processing (cold start / not authed) follows the existing `processReferral` localStorage pattern in `App.vue`.

**Tech Stack:** Capacitor 8, `@capgo/capacitor-share-target` v8, Vue 3 Composition API, Pinia (chatStore)

**Design doc:** `docs/plans/2026-04-09-android-share-target-design.md`

---

### Task 1: Install plugin and configure AndroidManifest.xml

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml:18-32` (main activity)
- Modify: `package.json` (new dependency)

**Step 1: Install the plugin**

Run:
```bash
npm install @capgo/capacitor-share-target
npx cap sync android
```

Expected: Package added to `package.json`, Android project synced.

**Step 2: Add intent-filters to AndroidManifest.xml**

In `android/app/src/main/AndroidManifest.xml`, inside the main `<activity>` (after the existing MAIN/LAUNCHER intent-filter at line 31), add:

```xml
            <!-- Share Target: receive content from other apps -->
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="video/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
```

**Step 3: Verify build**

Run:
```bash
npm run build && npx cap sync android
```

Expected: No errors.

**Step 4: Commit**

```bash
git add package.json yarn.lock android/app/src/main/AndroidManifest.xml
git commit -m "feat(share-target): install plugin and add Android intent-filters"
```

---

### Task 2: Add `isExternalShare` flag to ForwardingMessage type

**Files:**
- Modify: `src/entities/chat/model/types.ts:60-71`

**Step 1: Add the flag**

In `src/entities/chat/model/types.ts`, add `isExternalShare` to `ForwardingMessage`:

```typescript
/** State for a single message being forwarded to another chat */
export interface ForwardingMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName?: string;
  content: string;
  type: MessageType;
  fileInfo?: FileInfo;
  forwardedFrom?: { senderId: string; senderName?: string };
  /** Show original sender attribution (default true) */
  withSenderInfo: boolean;
  /** True when message originates from Android Share Sheet (not internal forward) */
  isExternalShare?: boolean;
}
```

**Step 2: Verify types**

Run:
```bash
npx vue-tsc --noEmit
```

Expected: No type errors.

**Step 3: Commit**

```bash
git add src/entities/chat/model/types.ts
git commit -m "feat(share-target): add isExternalShare flag to ForwardingMessage"
```

---

### Task 3: Add `initExternalShare` method to chatStore

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:476-490` (next to `initForward`)

**Step 1: Add the method**

In `src/entities/chat/model/chat-store.ts`, add `initExternalShare` right after `initForward` (after line 490):

```typescript
  /** Initialize forwarding from an external Android share (Share Sheet).
   *  Creates a synthetic ForwardingMessage and opens the ForwardPicker. */
  const initExternalShare = (data: { text?: string; fileUri?: string; fileName?: string; mimeType?: string }) => {
    const content = data.text || data.fileName || "";
    const isMedia = !!data.fileUri && !!data.mimeType;

    let type: MessageType = MessageType.text;
    if (isMedia) {
      if (data.mimeType!.startsWith("image/")) type = MessageType.image;
      else if (data.mimeType!.startsWith("video/")) type = MessageType.video;
      else type = MessageType.file;
    }

    forwardPickerRequested.value = true;
    forwardingMessage.value = {
      id: `__external_share_${Date.now()}`,
      roomId: "__external_share__",
      senderId: "",
      content,
      type,
      fileInfo: isMedia ? { url: data.fileUri!, name: data.fileName, mimetype: data.mimeType } as any : undefined,
      withSenderInfo: false,
      isExternalShare: true,
    };
  };
```

Also add `initExternalShare` to the return object of the store (find the return block that exports `initForward` around line 5720):

```typescript
    initExternalShare,
```

**Step 2: Verify types**

Run:
```bash
npx vue-tsc --noEmit
```

Expected: No type errors.

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "feat(share-target): add initExternalShare method to chatStore"
```

---

### Task 4: Create share-target service

**Files:**
- Create: `src/shared/lib/share-target.ts`

**Step 1: Create the service**

Create `src/shared/lib/share-target.ts`:

```typescript
import { isNative } from "@/shared/lib/platform";

const STORAGE_KEY = "bastyon-chat-share-data";

export interface ExternalShareData {
  text?: string;
  fileUri?: string;
  fileName?: string;
  mimeType?: string;
}

/** Save share data to localStorage for deferred processing (cold start / not authed) */
export function saveShareData(data: ExternalShareData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Read and clear deferred share data */
export function consumeShareData(): ExternalShareData | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  localStorage.removeItem(STORAGE_KEY);
  try {
    return JSON.parse(raw) as ExternalShareData;
  } catch {
    return null;
  }
}

/** Initialize the share target listener (call once on app mount, native only).
 *  Calls `onShare` when content is received from Android Share Sheet. */
export async function initShareTargetListener(
  onShare: (data: ExternalShareData) => void,
): Promise<void> {
  if (!isNative) return;

  const { CapacitorShareTarget } = await import("@capgo/capacitor-share-target");

  await CapacitorShareTarget.addListener("shareReceived", (event) => {
    const data: ExternalShareData = {};

    // Text / URL
    if (event.texts?.length) {
      data.text = event.texts.join("\n");
    }

    // First file (for now we handle single file; SEND_MULTIPLE can be extended later)
    if (event.files?.length) {
      const file = event.files[0];
      data.fileUri = file.uri;
      data.fileName = file.name;
      data.mimeType = file.mimeType;
    }

    if (data.text || data.fileUri) {
      onShare(data);
    }
  });
}
```

**Step 2: Verify types**

Run:
```bash
npx vue-tsc --noEmit
```

Expected: May warn about missing module types for the plugin — that's ok if the plugin ships its own types. If not, we'll add a `.d.ts` shim.

**Step 3: Commit**

```bash
git add src/shared/lib/share-target.ts
git commit -m "feat(share-target): create share-target service with listener and localStorage"
```

---

### Task 5: Integrate share target into App.vue

**Files:**
- Modify: `src/app/App.vue` (script setup section)

**Step 1: Add imports**

At the top of `<script setup>` in `src/app/App.vue`, after the existing imports (around line 21), add:

```typescript
import { initShareTargetListener, consumeShareData, saveShareData, type ExternalShareData } from "@/shared/lib/share-target";
```

**Step 2: Add `processExternalShare` function**

After `processPendingPushRoom` (around line 140), add:

```typescript
const processExternalShare = (data?: ExternalShareData) => {
  const shareData = data || consumeShareData();
  if (!shareData) return;

  if (!authStore.isAuthenticated || !authStore.matrixReady) {
    saveShareData(shareData);
    return;
  }

  // Wait for rooms to be initialized before opening picker
  if (!chatStore.roomsInitialized) {
    const unwatch = watch(
      () => chatStore.roomsInitialized,
      (ready) => {
        if (ready) {
          unwatch();
          chatStore.initExternalShare(shareData);
          router.push({ name: "ChatPage" });
        }
      },
      { immediate: true },
    );
    return;
  }

  chatStore.initExternalShare(shareData);
  router.push({ name: "ChatPage" });
};
```

**Step 3: Initialize listener in onMounted**

In the `onMounted` block, after `initAndroidBackListener()` (line 188), add:

```typescript
  // Initialize Android Share Target listener
  initShareTargetListener((data) => processExternalShare(data));
```

**Step 4: Add deferred share processing to matrixReady watcher**

In the `watch(() => authStore.matrixReady, ...)` block (around line 150-159), add inside the `if (ready)` block:

```typescript
      if (consumeShareData()) processExternalShare();
```

The watcher should look like:

```typescript
watch(
  () => authStore.matrixReady,
  (ready) => {
    if (ready) {
      if (localStorage.getItem("bastyon-chat-referral")) processReferral();
      if (localStorage.getItem("bastyon-chat-join-room")) processJoinRoom();
      processPendingPushRoom();
      if (consumeShareData()) processExternalShare();
    }
  },
);
```

Note: `consumeShareData()` is called as a check but then `processExternalShare()` will call it again and get null. Fix: peek without consuming:

```typescript
      const pendingShare = consumeShareData();
      if (pendingShare) processExternalShare(pendingShare);
```

**Step 5: Verify build**

Run:
```bash
npm run build
```

Expected: Build succeeds.

**Step 6: Commit**

```bash
git add src/app/App.vue
git commit -m "feat(share-target): integrate share handler into App.vue with deferred processing"
```

---

### Task 6: Handle external share in MessageInput forward preview

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue:313-317`

**Step 1: Fix `showForwardPreview` for external shares**

The current logic hides the forward preview when `activeRoomId === fwd.roomId`. External shares use `roomId: "__external_share__"` which will never match, so the preview will always show. **No change needed** — it works as-is.

**Step 2: Fix `forwardSourceRoomName` for external shares**

In `MessageInput.vue`, the `forwardSourceRoomName` computed (around line 334-338) will return empty string for external shares since `__external_share__` won't match any room. The UI shows "Forwarded from [name]" — for external shares this will just show "Forwarded message" which is correct since `withSenderInfo: false`.

**Verify:** No code changes needed for this task. The existing code handles the synthetic roomId gracefully.

**Step 3: Verify types**

Run:
```bash
npx vue-tsc --noEmit
```

Expected: No errors.

---

### Task 7: Handle external share file sending

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue` (handleSend function, around line 192)

**Step 1: Add file handling for external shares**

The current `handleSend` in MessageInput (line 192) calls `sendForward(forwardContent, forwardMeta)` which only sends text. For external shares with files, we need to also send the file.

In the `handleSend` function, modify the forward branch (around line 192-200):

```typescript
    } else if (chatStore.forwardingMessage) {
      const fwd = chatStore.forwardingMessage;

      // External share with file: send file directly instead of text forward
      if (fwd.isExternalShare && fwd.fileInfo?.url) {
        try {
          const response = await fetch(fwd.fileInfo.url);
          const blob = await response.blob();
          const fileName = fwd.fileInfo.name || "shared_file";
          const file = new File([blob], fileName, { type: fwd.fileInfo.mimetype || blob.type });

          if (fwd.type === MessageType.image) {
            inserted = await sendImage(file);
          } else {
            inserted = await sendFile(file);
          }
        } catch (e) {
          console.error("[MessageInput] Failed to send external share file:", e);
          inserted = false;
        }
        if (inserted !== false) chatStore.cancelForward();
      } else {
        const forwardMeta = fwd.withSenderInfo
          ? { senderId: fwd.senderId, senderName: fwd.senderName }
          : undefined;
        const forwardContent = rawText || fwd.content || forwardPreviewText.value;
        inserted = await sendForward(forwardContent, forwardMeta);
        if (inserted !== false) chatStore.cancelForward();
      }
```

**Step 2: Verify build**

Run:
```bash
npm run build
```

Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue
git commit -m "feat(share-target): handle external share file sending in MessageInput"
```

---

### Task 8: Write tests

**Files:**
- Create: `src/shared/lib/__tests__/share-target.test.ts`

**Step 1: Write unit tests for share-target service**

Create `src/shared/lib/__tests__/share-target.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveShareData, consumeShareData, type ExternalShareData } from "../share-target";

describe("share-target", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("saveShareData / consumeShareData", () => {
    it("saves and retrieves text share data", () => {
      const data: ExternalShareData = { text: "Hello from browser" };
      saveShareData(data);
      const result = consumeShareData();
      expect(result).toEqual(data);
    });

    it("clears data after consuming", () => {
      saveShareData({ text: "once" });
      consumeShareData();
      expect(consumeShareData()).toBeNull();
    });

    it("returns null when no data saved", () => {
      expect(consumeShareData()).toBeNull();
    });

    it("saves file share data", () => {
      const data: ExternalShareData = {
        fileUri: "content://media/image.jpg",
        fileName: "image.jpg",
        mimeType: "image/jpeg",
      };
      saveShareData(data);
      expect(consumeShareData()).toEqual(data);
    });

    it("handles corrupted localStorage gracefully", () => {
      localStorage.setItem("bastyon-chat-share-data", "not-json{{{");
      expect(consumeShareData()).toBeNull();
    });
  });
});
```

**Step 2: Run tests**

Run:
```bash
npx vitest run src/shared/lib/__tests__/share-target.test.ts
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/shared/lib/__tests__/share-target.test.ts
git commit -m "test(share-target): add unit tests for share-target service"
```

---

### Task 9: Final verification

**Step 1: Full build**

Run:
```bash
npm run build
```

**Step 2: Lint**

Run:
```bash
npm run lint
```

**Step 3: Type check**

Run:
```bash
npx vue-tsc --noEmit
```

**Step 4: All tests**

Run:
```bash
npm run test
```

**Step 5: Code review**

Use `superpowers:code-reviewer` to review all changes.

**Step 6: Final commit (if any fixes needed)**

```bash
git commit -m "fix(share-target): address review feedback"
```

---

## Manual Testing Checklist (on Android device/emulator)

1. Build APK: `npx cap run android`
2. Open Gallery → select image → Share → verify "Forta Chat" appears in share sheet
3. Select Forta Chat → verify ForwardPicker opens with room list
4. Select a chat → verify preview bar shows in MessageInput
5. Tap Send → verify image is sent to the chat
6. Open Browser → share a URL → verify text share works
7. Test cold start: kill app → share from Gallery → verify app launches and picker opens after auth
8. Test when not logged in: clear app data → share → log in → verify deferred share processes
