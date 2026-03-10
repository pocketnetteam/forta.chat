# Link Preview (Telegram-style) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Telegram-style URL link previews — in message input (with dismiss) and in rendered messages — using Matrix SDK's `getUrlPreview()` with hybrid storage and LRU cache.

**Architecture:** Matrix SDK fetches OG metadata server-side via `/_matrix/media/v3/preview_url`. Preview data is attached to outgoing messages in a custom `url_preview` field. On receive, if `url_preview` exists — render immediately; otherwise fetch on-demand and cache. Input bar shows a compact preview above the textarea while typing a URL, with a dismiss (X) button.

**Tech Stack:** Vue 3 + Composition API, matrix-js-sdk-bastyon, Tailwind CSS, i18n (en/ru)

---

### Task 1: Add LinkPreview type and extend Message interface

**Files:**
- Modify: `src/entities/chat/model/types.ts:47-84`

**Step 1: Add LinkPreview interface and extend Message**

Add after the `ReplyTo` interface (line 45):

```ts
/** Open Graph metadata for URL link previews */
export interface LinkPreview {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
}
```

Add to `Message` interface, after `transferInfo`:

```ts
  /** URL link preview metadata (Open Graph) */
  linkPreview?: LinkPreview;
```

**Step 2: Commit**

```bash
git add src/entities/chat/model/types.ts
git commit -m "feat(link-preview): add LinkPreview type and extend Message interface"
```

---

### Task 2: Add getUrlPreview method to MatrixClientService

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts:393` (after mxcToHttp)

**Step 1: Add getUrlPreview method**

Add after the `mxcToHttp` method (line 396):

```ts
  /** Fetch URL preview (Open Graph metadata) from Matrix server */
  async getUrlPreview(url: string): Promise<{
    siteName?: string;
    title?: string;
    description?: string;
    imageUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
  } | null> {
    if (!this.client) return null;
    try {
      const data = await this.client.getUrlPreview(url, Date.now());
      const mxcImage = data["og:image"] as string | undefined;
      return {
        siteName: data["og:site_name"] as string | undefined,
        title: data["og:title"] as string | undefined,
        description: data["og:description"] as string | undefined,
        imageUrl: mxcImage ? (this.client.mxcUrlToHttp(mxcImage) ?? undefined) : undefined,
        imageWidth: data["og:image:width"] as number | undefined,
        imageHeight: data["og:image:height"] as number | undefined,
      };
    } catch (e) {
      console.warn("[matrix-client] getUrlPreview error:", e);
      return null;
    }
  }
```

**Step 2: Commit**

```bash
git add src/entities/matrix/model/matrix-client.ts
git commit -m "feat(link-preview): add getUrlPreview to MatrixClientService"
```

---

### Task 3: Create useLinkPreview composable with LRU cache

**Files:**
- Create: `src/features/messaging/model/use-link-preview.ts`

**Step 1: Create the composable**

```ts
import { ref, watch, type Ref } from "vue";
import { getMatrixClientService } from "@/entities/matrix";
import type { LinkPreview } from "@/entities/chat";

/** Simple LRU cache for URL previews */
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.maxSize) {
      // Delete oldest (first entry)
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

const cache = new LRUCache<string, LinkPreview | null>(200);
const inflight = new Map<string, Promise<LinkPreview | null>>();

const URL_RE = /https?:\/\/[^\s<>]+/;

/** Extract the first URL from text */
export function detectUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

/** Fetch preview for a URL (cached, deduplicated) */
export async function fetchPreview(url: string): Promise<LinkPreview | null> {
  if (cache.has(url)) return cache.get(url)!;

  // Deduplicate in-flight requests
  if (inflight.has(url)) return inflight.get(url)!;

  const promise = (async () => {
    const service = getMatrixClientService();
    const data = await service.getUrlPreview(url);
    if (!data || (!data.title && !data.description && !data.siteName)) {
      cache.set(url, null);
      return null;
    }
    const preview: LinkPreview = {
      url,
      siteName: data.siteName,
      title: data.title,
      description: data.description?.slice(0, 200),
      imageUrl: data.imageUrl,
      imageWidth: data.imageWidth,
      imageHeight: data.imageHeight,
    };
    cache.set(url, preview);
    return preview;
  })();

  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(url);
  }
}

/**
 * Composable for input link preview.
 * Watches a text ref, detects URLs with debounce, fetches preview.
 */
export function useLinkPreview(text: Ref<string>) {
  const preview = ref<LinkPreview | null>(null);
  const loading = ref(false);
  const dismissed = ref(false);
  const lastUrl = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  watch(text, (val) => {
    clearTimeout(debounceTimer);
    const url = detectUrl(val);

    // URL removed from text — clear preview
    if (!url) {
      preview.value = null;
      loading.value = false;
      lastUrl.value = null;
      dismissed.value = false;
      return;
    }

    // Same URL — no need to refetch
    if (url === lastUrl.value) return;

    // New URL — reset dismissed state
    dismissed.value = false;
    lastUrl.value = url;
    loading.value = true;

    debounceTimer = setTimeout(async () => {
      try {
        preview.value = await fetchPreview(url);
      } catch {
        preview.value = null;
      } finally {
        loading.value = false;
      }
    }, 500);
  });

  const dismiss = () => {
    dismissed.value = true;
  };

  /** Get the active preview (null if dismissed or not loaded) */
  const activePreview = computed(() => {
    if (dismissed.value) return null;
    return preview.value;
  });

  return {
    preview,
    activePreview,
    loading,
    dismissed,
    dismiss,
    lastUrl,
  };
}
```

**Step 2: Commit**

```bash
git add src/features/messaging/model/use-link-preview.ts
git commit -m "feat(link-preview): create useLinkPreview composable with LRU cache"
```

---

### Task 4: Add i18n translations for link preview

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts` (after "quickSearch" section, line 490)
- Modify: `src/shared/lib/i18n/locales/ru.ts` (after "quickSearch" section, line 491)

**Step 1: Add English translations**

Add after the quick search section:

```ts
  // ── Link preview ──
  "linkPreview.loading": "Loading...",
  "linkPreview.linkPreview": "Link preview",
```

**Step 2: Add Russian translations**

```ts
  // ── Link preview ──
  "linkPreview.loading": "Загрузка...",
  "linkPreview.linkPreview": "Превью ссылки",
```

**Step 3: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat(link-preview): add i18n translations"
```

---

### Task 5: Add link preview bar to MessageInput

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`

**Step 1: Import useLinkPreview and wire it up**

Add import (after line 7):

```ts
import { useLinkPreview } from "../model/use-link-preview";
```

After `const text = ref("");` (line 31), add:

```ts
const linkPreview = useLinkPreview(text);
```

**Step 2: Pass preview data to handleSend**

In `handleSend` (line 97), modify the `sendMessage` and `sendReply` calls to pass the active preview. Change:

```ts
  } else if (chatStore.replyingTo) {
    sendReply(rawText);
  } else {
    sendMessage(rawText);
  }
```

To:

```ts
  } else if (chatStore.replyingTo) {
    sendReply(rawText, linkPreview.activePreview.value ?? undefined);
  } else {
    sendMessage(rawText, linkPreview.activePreview.value ?? undefined);
  }
```

**Step 3: Add link preview bar template**

Add a new `<transition>` block after the reply preview bar (after line 319), before VoiceRecorder:

```vue
    <!-- Link preview bar -->
    <transition name="input-bar">
      <div
        v-if="!isEditing && !chatStore.replyingTo && (linkPreview.loading.value || linkPreview.activePreview.value)"
        class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
      >
        <div class="flex h-8 w-8 shrink-0 items-center justify-center text-text-on-main-bg-color/40">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
        <div class="min-w-0 flex-1">
          <template v-if="linkPreview.loading.value">
            <div class="text-xs font-medium text-text-on-main-bg-color/60">{{ $t('linkPreview.loading') }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color/40">{{ linkPreview.lastUrl.value }}</div>
          </template>
          <template v-else-if="linkPreview.activePreview.value">
            <div class="truncate text-xs font-medium text-text-on-main-bg-color/60">
              {{ linkPreview.activePreview.value.siteName || linkPreview.activePreview.value.title || 'Link' }}
            </div>
            <div class="truncate text-xs text-text-on-main-bg-color/40">
              {{ linkPreview.activePreview.value.description || linkPreview.activePreview.value.url }}
            </div>
          </template>
        </div>
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          :aria-label="$t('linkPreview.linkPreview')"
          @click="linkPreview.dismiss()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition>
```

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue
git commit -m "feat(link-preview): add preview bar to MessageInput with dismiss"
```

---

### Task 6: Wire link preview into sendMessage and sendReply

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts`

**Step 1: Update sendMessage signature and logic**

Change `sendMessage` (line 29):

```ts
  const sendMessage = async (content: string, linkPreview?: LinkPreview) => {
```

Add import at top of file:

```ts
import type { FileInfo, Message, LinkPreview } from "@/entities/chat";
```

In the optimistic message creation (line 40-48), add:

```ts
      ...(linkPreview ? { linkPreview } : {}),
```

After `const trimmed = content.trim();` and before the message creation.

In the Matrix send content, when building for both encrypted and plaintext, the text content is sent via `matrixService.sendText()` or `matrixService.sendEncryptedText()`. For text messages with preview, we need to attach `url_preview` to the event content.

Change the plaintext send path (line 69):

```ts
        serverEventId = await matrixService.sendText(roomId, trimmed);
```

To:

```ts
        if (linkPreview) {
          // Send with url_preview metadata
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
```

For encrypted path (line 65-66), add url_preview:

```ts
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
```

Also set `linkPreview` on the optimistic message:

```ts
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
```

**Step 2: Update sendReply similarly**

Change signature (line 399):

```ts
  const sendReply = async (content: string, linkPreview?: LinkPreview) => {
```

Add `linkPreview` to optimistic message (line 411-427).

Add `url_preview` to `msgContent` (line 432-440) when `linkPreview` is provided:

```ts
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
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-messages.ts
git commit -m "feat(link-preview): attach preview data to sent messages"
```

---

### Task 7: Parse url_preview from incoming Matrix events

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts` — find `parseSingleEvent` or the event parsing function

First, find where incoming Matrix events are parsed into `Message` objects. Search for `parseSingleEvent` or the function that creates Message objects from raw events.

**Step 1: Extract linkPreview from event content**

In the event parsing function, after parsing other fields, add:

```ts
    // Extract link preview from event content
    let linkPreview: LinkPreview | undefined;
    const urlPreview = content.url_preview as Record<string, unknown> | undefined;
    if (urlPreview?.url) {
      linkPreview = {
        url: urlPreview.url as string,
        siteName: urlPreview.site_name as string | undefined,
        title: urlPreview.title as string | undefined,
        description: urlPreview.description as string | undefined,
        imageUrl: urlPreview.image_url as string | undefined,
        imageWidth: urlPreview.image_width as number | undefined,
        imageHeight: urlPreview.image_height as number | undefined,
      };
    }
```

And include `linkPreview` in the returned Message object.

**Note:** This task requires reading `chat-store.ts` to find the exact location. The executor should search for where `Message` objects are constructed from raw Matrix event data.

**Step 2: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "feat(link-preview): parse url_preview from incoming Matrix events"
```

---

### Task 8: Create LinkPreviewCard component for messages

**Files:**
- Create: `src/features/messaging/ui/LinkPreviewCard.vue`

**Step 1: Create the component**

```vue
<script setup lang="ts">
import type { LinkPreview } from "@/entities/chat";

const props = defineProps<{
  preview: LinkPreview;
  isOwn: boolean;
}>();

const openUrl = () => {
  window.open(props.preview.url, "_blank", "noopener,noreferrer");
};

const siteName = computed(() => {
  if (props.preview.siteName) return props.preview.siteName;
  try {
    return new URL(props.preview.url).hostname;
  } catch {
    return props.preview.url;
  }
});
</script>

<template>
  <div
    class="mt-1.5 cursor-pointer overflow-hidden rounded-lg border-l-2 border-color-bg-ac"
    :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
    @click.stop="openUrl"
  >
    <div class="px-2.5 py-1.5">
      <div class="truncate text-xs font-medium" :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
        {{ siteName }}
      </div>
      <div v-if="preview.title" class="mt-0.5 line-clamp-2 text-sm font-semibold leading-tight"
        :class="props.isOwn ? 'text-white/90' : 'text-text-color'">
        {{ preview.title }}
      </div>
      <div v-if="preview.description" class="mt-0.5 line-clamp-3 text-xs leading-relaxed"
        :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
        {{ preview.description }}
      </div>
    </div>
    <img
      v-if="preview.imageUrl"
      :src="preview.imageUrl"
      :alt="preview.title || ''"
      class="block max-h-[200px] w-full object-cover"
      loading="lazy"
      @error="($event.target as HTMLImageElement).style.display = 'none'"
    />
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/LinkPreviewCard.vue
git commit -m "feat(link-preview): create LinkPreviewCard component"
```

---

### Task 9: Render LinkPreviewCard in MessageContent

**Files:**
- Modify: `src/features/messaging/ui/MessageContent.vue`

**Step 1: Add props and import**

Add `linkPreview` prop to the component:

```ts
import type { LinkPreview } from "@/entities/chat";
import LinkPreviewCard from "./LinkPreviewCard.vue";

interface Props {
  text: string;
  isOwn?: boolean;
  linkPreview?: LinkPreview | null;
}
```

**Step 2: Add on-demand preview fetching for messages without embedded preview**

```ts
import { ref, computed, inject, onMounted, type Ref } from "vue";
import { fetchPreview, detectUrl } from "../model/use-link-preview";

// Fetch preview on-demand for messages without embedded preview
const fetchedPreview = ref<LinkPreview | null>(null);
const effectivePreview = computed(() => props.linkPreview ?? fetchedPreview.value);

// Only fetch if no embedded preview and text has a URL
onMounted(async () => {
  if (props.linkPreview) return;
  const url = detectUrl(props.text);
  if (!url) return;
  fetchedPreview.value = await fetchPreview(url);
});
```

**Step 3: Add LinkPreviewCard to template**

For the block-level path (v-if="hasBlockSegments"), add after the template loop:

```vue
    <LinkPreviewCard v-if="effectivePreview" :preview="effectivePreview" :is-own="props.isOwn" />
```

For the inline path (v-else), wrap in a div and add the card:

Change:
```vue
  <span v-else class="whitespace-pre-wrap break-words">
    <!-- inline segments -->
  </span>
```

To:
```vue
  <div v-else>
    <span class="whitespace-pre-wrap break-words">
      <!-- existing inline segments unchanged -->
    </span>
    <LinkPreviewCard v-if="effectivePreview" :preview="effectivePreview" :is-own="props.isOwn" />
  </div>
```

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageContent.vue
git commit -m "feat(link-preview): render LinkPreviewCard in messages"
```

---

### Task 10: Pass linkPreview prop from MessageBubble to MessageContent

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue:614`

**Step 1: Pass linkPreview to MessageContent**

Find the text message `<MessageContent>` call (line 614):

```vue
          <MessageContent :text="props.message.content" :is-own="props.isOwn" @mention-click="(userId) => openUserProfile?.(userId)" />
```

Change to:

```vue
          <MessageContent :text="props.message.content" :is-own="props.isOwn" :link-preview="props.message.linkPreview" @mention-click="(userId) => openUserProfile?.(userId)" />
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/MessageBubble.vue
git commit -m "feat(link-preview): pass linkPreview from MessageBubble to MessageContent"
```

---

### Task 11: Test end-to-end

**Step 1: Run dev server**

```bash
npm run dev
```

**Step 2: Test input preview**

1. Open any chat
2. Type a URL like `https://youtube.com/watch?v=dQw4w9WgXcQ`
3. Verify: preview bar appears above input with "Loading..." → then site name + description
4. Click X → preview dismissed
5. Delete URL → preview bar disappears
6. Re-type URL → preview reappears (dismiss reset)

**Step 3: Test message preview**

1. Send a message with a URL (with preview visible)
2. Verify: sent message shows LinkPreviewCard with title, description, image
3. Verify: the `url_preview` data is in the event (check via console)

**Step 4: Test dismiss flow**

1. Type URL → dismiss preview → send message
2. Verify: sent message has NO link preview card

**Step 5: Test old messages (on-demand fetch)**

1. Find an older message with a URL
2. Verify: LinkPreviewCard fetches and renders after a moment

**Step 6: Commit**

If any fixes were needed:

```bash
git add -A
git commit -m "fix(link-preview): adjustments from manual testing"
```
