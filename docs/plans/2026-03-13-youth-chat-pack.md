# Youth Chat Pack Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Emoji Kitchen, GIF search (Tenor), fullscreen animated reactions, built-in sticker packs, and wave typing bubble to make the chat more appealing to younger audiences.

**Architecture:** Five independent features built as composable Vue components, integrated into the existing EmojiPicker (refactored to tabbed layout) and MessageList. Each feature is self-contained with its own data layer. Stickers/GIFs send as Matrix image messages; Emoji Kitchen combinations send as sticker images. Reaction effects use CSS animations teleported to body.

**Tech Stack:** Vue 3 + TypeScript + Pinia + Tailwind CSS. New dependency: `emoji-kitchen-mart`. Tenor v2 REST API (plain fetch). CSS keyframe animations for effects.

---

### Task 1: Add `emoji-kitchen-mart` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run: `npm install emoji-kitchen-mart`

**Step 2: Verify installation**

Run: `npm ls emoji-kitchen-mart`
Expected: Shows version in dependency tree

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add emoji-kitchen-mart dependency for Emoji Kitchen feature"
```

---

### Task 2: Create Emoji Kitchen lookup wrapper

**Files:**
- Create: `src/shared/lib/emoji-kitchen.ts`

**Step 1: Create the wrapper module**

```typescript
// src/shared/lib/emoji-kitchen.ts
import { getEmojiKitchenCombo } from "emoji-kitchen-mart";

export interface KitchenCombo {
  emoji: string;      // combined emoji representation
  imageUrl: string;    // Google Noto PNG URL
}

/**
 * Get all available Emoji Kitchen combinations for a given emoji.
 * Returns an array of combo objects with image URLs.
 */
export function getKitchenCombos(emoji: string): KitchenCombo[] {
  try {
    const results = getEmojiKitchenCombo(emoji);
    if (!results || !Array.isArray(results)) return [];
    return results.map((r: any) => ({
      emoji: r.emoji ?? `${emoji}+${r.baseEmoji ?? ""}`,
      imageUrl: r.url ?? r.imageUrl ?? "",
    })).filter((r: KitchenCombo) => r.imageUrl);
  } catch {
    return [];
  }
}

/**
 * Get the specific combination of two emojis.
 * Returns the image URL or null if no combination exists.
 */
export function getKitchenCombo(emoji1: string, emoji2: string): string | null {
  try {
    const combos = getKitchenCombos(emoji1);
    const match = combos.find(c => c.emoji.includes(emoji2));
    return match?.imageUrl ?? null;
  } catch {
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add src/shared/lib/emoji-kitchen.ts
git commit -m "feat: add Emoji Kitchen lookup wrapper"
```

> **Note:** The exact API of `emoji-kitchen-mart` may differ — check `node_modules/emoji-kitchen-mart` for the actual exports and adjust the wrapper accordingly before proceeding.

---

### Task 3: Create Tenor API client

**Files:**
- Create: `src/shared/lib/tenor.ts`

**Step 1: Create the Tenor API module**

```typescript
// src/shared/lib/tenor.ts

const TENOR_API_KEY = import.meta.env.VITE_TENOR_API_KEY || "AIzaSyBqRGYRPBaPP3gwBPkaOY0eHFEPxqjgd9c"; // Public fallback key
const TENOR_BASE = "https://tenor.googleapis.com/v2";

export interface TenorGif {
  id: string;
  title: string;
  previewUrl: string;    // tiny GIF for grid
  gifUrl: string;         // full-size GIF for sending
  width: number;
  height: number;
}

interface TenorResponse {
  results: Array<{
    id: string;
    title: string;
    media_formats: {
      tinygif?: { url: string; dims: [number, number] };
      gif?: { url: string; dims: [number, number] };
      mediumgif?: { url: string; dims: [number, number] };
    };
  }>;
  next: string;
}

function mapResult(r: TenorResponse["results"][0]): TenorGif {
  const preview = r.media_formats.tinygif;
  const full = r.media_formats.mediumgif ?? r.media_formats.gif;
  return {
    id: r.id,
    title: r.title,
    previewUrl: preview?.url ?? full?.url ?? "",
    gifUrl: full?.url ?? preview?.url ?? "",
    width: preview?.dims?.[0] ?? 200,
    height: preview?.dims?.[1] ?? 200,
  };
}

export async function searchGifs(query: string, limit = 20, next?: string): Promise<{ gifs: TenorGif[]; next: string }> {
  const params = new URLSearchParams({
    key: TENOR_API_KEY,
    q: query,
    limit: String(limit),
    media_filter: "tinygif,mediumgif,gif",
    contentfilter: "medium",
  });
  if (next) params.set("pos", next);

  const res = await fetch(`${TENOR_BASE}/search?${params}`);
  if (!res.ok) throw new Error(`Tenor search failed: ${res.status}`);
  const data: TenorResponse = await res.json();
  return {
    gifs: data.results.map(mapResult).filter(g => g.gifUrl),
    next: data.next,
  };
}

export async function getTrending(limit = 20, next?: string): Promise<{ gifs: TenorGif[]; next: string }> {
  const params = new URLSearchParams({
    key: TENOR_API_KEY,
    limit: String(limit),
    media_filter: "tinygif,mediumgif,gif",
    contentfilter: "medium",
  });
  if (next) params.set("pos", next);

  const res = await fetch(`${TENOR_BASE}/featured?${params}`);
  if (!res.ok) throw new Error(`Tenor featured failed: ${res.status}`);
  const data: TenorResponse = await res.json();
  return {
    gifs: data.results.map(mapResult).filter(g => g.gifUrl),
    next: data.next,
  };
}

/** Fetch GIF as blob for uploading to Matrix */
export async function fetchGifBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch GIF: ${res.status}`);
  return res.blob();
}
```

**Step 2: Add env variable placeholder**

Add to `.env.example` (or create if doesn't exist):
```
VITE_TENOR_API_KEY=your_tenor_api_key_here
```

**Step 3: Commit**

```bash
git add src/shared/lib/tenor.ts
git commit -m "feat: add Tenor v2 API client for GIF search"
```

---

### Task 4: Create sticker pack manifest and loader

**Files:**
- Create: `public/stickers/manifest.json`
- Create: `src/shared/lib/sticker-packs.ts`

**Step 1: Create sticker manifest**

```json
{
  "packs": [
    {
      "id": "emotions",
      "name": "Emotions",
      "icon": "happy.webp",
      "stickers": [
        "happy.webp", "sad.webp", "angry.webp", "love.webp", "laugh.webp",
        "cry.webp", "shock.webp", "cool.webp", "think.webp", "sleep.webp"
      ]
    },
    {
      "id": "cats",
      "name": "Cats",
      "icon": "cat-happy.webp",
      "stickers": [
        "cat-happy.webp", "cat-sad.webp", "cat-angry.webp", "cat-love.webp",
        "cat-laugh.webp", "cat-sleep.webp", "cat-shock.webp", "cat-cool.webp"
      ]
    },
    {
      "id": "memes",
      "name": "Memes",
      "icon": "thumbsup.webp",
      "stickers": [
        "thumbsup.webp", "facepalm.webp", "shrug.webp", "clap.webp",
        "fire.webp", "mindblown.webp", "party.webp", "salute.webp"
      ]
    }
  ]
}
```

**Step 2: Create sticker pack loader**

```typescript
// src/shared/lib/sticker-packs.ts
import { ref, shallowRef } from "vue";

export interface Sticker {
  id: string;
  url: string;
  packId: string;
}

export interface StickerPack {
  id: string;
  name: string;
  iconUrl: string;
  stickers: Sticker[];
}

const packs = shallowRef<StickerPack[]>([]);
const loaded = ref(false);

export async function loadStickerPacks(): Promise<StickerPack[]> {
  if (loaded.value) return packs.value;
  try {
    const res = await fetch("/stickers/manifest.json");
    if (!res.ok) throw new Error(`Failed to load sticker manifest: ${res.status}`);
    const data = await res.json();
    packs.value = data.packs.map((p: any) => ({
      id: p.id,
      name: p.name,
      iconUrl: `/stickers/${p.id}/${p.icon}`,
      stickers: p.stickers.map((s: string) => ({
        id: `${p.id}-${s}`,
        url: `/stickers/${p.id}/${s}`,
        packId: p.id,
      })),
    }));
    loaded.value = true;
  } catch (e) {
    console.warn("Failed to load sticker packs:", e);
    packs.value = [];
  }
  return packs.value;
}

export function useStickerPacks() {
  return { packs, loaded, loadStickerPacks };
}
```

**Step 3: Create placeholder sticker directories**

Run:
```bash
mkdir -p public/stickers/emotions public/stickers/cats public/stickers/memes
```

> **Note:** Actual sticker WebP assets need to be added later (sourced or created). The system will work with placeholder/missing images until then.

**Step 4: Commit**

```bash
git add public/stickers/manifest.json src/shared/lib/sticker-packs.ts
git commit -m "feat: add sticker pack manifest and loader"
```

---

### Task 5: Add `sendSticker` and `sendGif` to use-messages

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts` (add two new functions)
- Modify: `src/entities/chat/model/types.ts` (add `sticker` to MessageType)

**Step 1: Add `sticker` to MessageType enum**

In `src/entities/chat/model/types.ts`, add to the MessageType enum:

```typescript
export enum MessageType {
  text = "text",
  image = "image",
  file = "file",
  video = "video",
  audio = "audio",
  system = "system",
  poll = "poll",
  transfer = "transfer",
  sticker = "sticker",  // <-- ADD THIS
}
```

**Step 2: Add `sendSticker` function to use-messages.ts**

Add after the existing `sendImage` function. The function should:
- Accept `url: string` (sticker/kitchen image URL) and `info?: { w?: number; h?: number }`
- Fetch the image as blob
- Upload to Matrix via `kit.sendImageMessage` with msgtype hint for sticker
- Create optimistic local message with `MessageType.sticker`

Pattern: Follow `sendImage` but fetch from URL instead of File input.

```typescript
const sendSticker = async (imageUrl: string, info?: { w?: number; h?: number }) => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return;

  // Fetch image blob
  const res = await fetch(imageUrl);
  const blob = await res.blob();
  const file = new File([blob], "sticker.webp", { type: blob.type || "image/webp" });

  // Create optimistic message
  const tempId = `~${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  chatStore.addOptimisticMessage(roomId, {
    id: tempId,
    roomId,
    senderId: authStore.address!,
    content: "",
    timestamp: Date.now(),
    status: MessageStatus.sending,
    type: MessageType.sticker,
    fileInfo: {
      name: "sticker.webp",
      size: blob.size,
      type: blob.type || "image/webp",
      w: info?.w ?? 200,
      h: info?.h ?? 200,
    },
  });

  try {
    const kit = getMatrixClientService();
    // Upload and send as image (stickers are images with specific rendering)
    await kit.sendImageMessage(roomId, file);
    chatStore.updateMessageStatus(tempId, MessageStatus.sent);
  } catch (e) {
    chatStore.updateMessageStatus(tempId, MessageStatus.failed);
    throw e;
  }
};
```

**Step 3: Add `sendGif` function**

Similar to `sendSticker` but for GIF blobs:

```typescript
const sendGif = async (gifUrl: string, info?: { w?: number; h?: number; title?: string }) => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return;

  const res = await fetch(gifUrl);
  const blob = await res.blob();
  const file = new File([blob], "animation.gif", { type: "image/gif" });

  const tempId = `~${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  chatStore.addOptimisticMessage(roomId, {
    id: tempId,
    roomId,
    senderId: authStore.address!,
    content: info?.title ?? "",
    timestamp: Date.now(),
    status: MessageStatus.sending,
    type: MessageType.image,
    fileInfo: {
      name: "animation.gif",
      size: blob.size,
      type: "image/gif",
      w: info?.w ?? 300,
      h: info?.h ?? 300,
    },
  });

  try {
    const kit = getMatrixClientService();
    await kit.sendImageMessage(roomId, file);
    chatStore.updateMessageStatus(tempId, MessageStatus.sent);
  } catch (e) {
    chatStore.updateMessageStatus(tempId, MessageStatus.failed);
    throw e;
  }
};
```

**Step 4: Export both functions from the composable return**

Add `sendSticker` and `sendGif` to the `return { ... }` object.

**Step 5: Commit**

```bash
git add src/entities/chat/model/types.ts src/features/messaging/model/use-messages.ts
git commit -m "feat: add sendSticker and sendGif message functions"
```

---

### Task 6: Create EmojiKitchenBar component

**Files:**
- Create: `src/features/messaging/ui/EmojiKitchenBar.vue`

**Step 1: Create the component**

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { getKitchenCombos, type KitchenCombo } from "@/shared/lib/emoji-kitchen";

interface Props {
  selectedEmoji: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ select: [imageUrl: string] }>();

const combos = ref<KitchenCombo[]>([]);
const scrollRef = ref<HTMLElement>();

watch(() => props.selectedEmoji, (emoji) => {
  if (emoji) {
    combos.value = getKitchenCombos(emoji).slice(0, 30);
    // Reset scroll
    if (scrollRef.value) scrollRef.value.scrollLeft = 0;
  } else {
    combos.value = [];
  }
});
</script>

<template>
  <transition name="kitchen-slide">
    <div
      v-if="combos.length > 0"
      ref="scrollRef"
      class="flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-grad-0/50 px-2 py-1.5 scrollbar-hide"
    >
      <button
        v-for="combo in combos"
        :key="combo.imageUrl"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-transform hover:scale-110 hover:bg-neutral-grad-0 active:scale-95"
        @click="emit('select', combo.imageUrl)"
      >
        <img
          :src="combo.imageUrl"
          :alt="combo.emoji"
          class="h-8 w-8 object-contain"
          loading="lazy"
        />
      </button>
    </div>
  </transition>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

.kitchen-slide-enter-active { transition: max-height 0.2s ease, opacity 0.2s ease; }
.kitchen-slide-leave-active { transition: max-height 0.15s ease, opacity 0.15s ease; }
.kitchen-slide-enter-from, .kitchen-slide-leave-to { max-height: 0; opacity: 0; overflow: hidden; }
.kitchen-slide-enter-to, .kitchen-slide-leave-from { max-height: 52px; opacity: 1; }
</style>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/EmojiKitchenBar.vue
git commit -m "feat: add EmojiKitchenBar component"
```

---

### Task 7: Create GifPicker component

**Files:**
- Create: `src/features/messaging/ui/GifPicker.vue`

**Step 1: Create the GIF picker with Tenor search**

```vue
<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { searchGifs, getTrending, type TenorGif } from "@/shared/lib/tenor";

const emit = defineEmits<{ select: [gif: TenorGif]; close: [] }>();

const search = ref("");
const gifs = ref<TenorGif[]>([]);
const loading = ref(false);
const nextPos = ref("");
const searchInputRef = ref<HTMLInputElement>();

let debounceTimer: ReturnType<typeof setTimeout>;

const loadGifs = async (query: string, append = false) => {
  loading.value = true;
  try {
    const result = query
      ? await searchGifs(query, 20, append ? nextPos.value : undefined)
      : await getTrending(20, append ? nextPos.value : undefined);
    if (append) {
      gifs.value = [...gifs.value, ...result.gifs];
    } else {
      gifs.value = result.gifs;
    }
    nextPos.value = result.next;
  } catch (e) {
    console.warn("GIF load failed:", e);
  } finally {
    loading.value = false;
  }
};

watch(search, (q) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => loadGifs(q.trim()), 300);
});

onMounted(() => {
  loadGifs("");
  searchInputRef.value?.focus();
});

const onGridScroll = (e: Event) => {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && !loading.value && nextPos.value) {
    loadGifs(search.value.trim(), true);
  }
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Search -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <div class="relative">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-grad-2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="searchInputRef"
          v-model="search"
          type="text"
          placeholder="Search GIFs..."
          class="w-full rounded-xl bg-chat-input-bg py-2 pl-9 pr-3 text-sm text-text-color outline-none placeholder:text-neutral-grad-2 focus:ring-2 focus:ring-color-bg-ac/20"
        />
      </div>
    </div>

    <!-- GIF grid (2-column masonry) -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-1" @scroll="onGridScroll">
      <div class="grid grid-cols-2 gap-1">
        <button
          v-for="gif in gifs"
          :key="gif.id"
          class="overflow-hidden rounded-lg transition-transform hover:scale-[1.02] active:scale-95"
          @click="emit('select', gif)"
        >
          <img
            :src="gif.previewUrl"
            :alt="gif.title"
            class="w-full object-cover"
            :style="{ aspectRatio: `${gif.width}/${gif.height}` }"
            loading="lazy"
          />
        </button>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="flex justify-center py-4">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
      </div>

      <!-- Empty -->
      <div v-if="!loading && gifs.length === 0 && search" class="flex h-32 items-center justify-center text-sm text-text-on-main-bg-color/50">
        No GIFs found
      </div>
    </div>

    <!-- Tenor attribution -->
    <div class="shrink-0 px-3 py-1 text-center text-[10px] text-text-on-main-bg-color/40">
      Powered by Tenor
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/GifPicker.vue
git commit -m "feat: add GifPicker component with Tenor search"
```

---

### Task 8: Create StickerPicker component

**Files:**
- Create: `src/features/messaging/ui/StickerPicker.vue`

**Step 1: Create the sticker picker**

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useStickerPacks, type StickerPack, type Sticker } from "@/shared/lib/sticker-packs";

const emit = defineEmits<{ select: [sticker: Sticker] }>();

const { packs, loadStickerPacks } = useStickerPacks();
const activePackIndex = ref(0);

onMounted(() => {
  loadStickerPacks();
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Pack tabs -->
    <div class="flex shrink-0 gap-0.5 border-b border-neutral-grad-0/50 px-2 pb-1 pt-2">
      <button
        v-for="(pack, i) in packs"
        :key="pack.id"
        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150"
        :class="activePackIndex === i
          ? 'bg-color-bg-ac/12 scale-110'
          : 'hover:bg-neutral-grad-0 opacity-70 hover:opacity-100'"
        :title="pack.name"
        @click="activePackIndex = i"
      >
        <img :src="pack.iconUrl" :alt="pack.name" class="h-6 w-6 object-contain" />
        <div
          v-if="activePackIndex === i"
          class="absolute -bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-color-bg-ac"
        />
      </button>
    </div>

    <!-- Sticker grid -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <template v-if="packs[activePackIndex]">
        <div class="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-text-on-main-bg-color/60">
          {{ packs[activePackIndex].name }}
        </div>
        <div class="grid grid-cols-4 gap-2">
          <button
            v-for="sticker in packs[activePackIndex].stickers"
            :key="sticker.id"
            class="flex items-center justify-center rounded-lg p-2 transition-transform hover:scale-110 hover:bg-neutral-grad-0 active:scale-95"
            @click="emit('select', sticker)"
          >
            <img :src="sticker.url" :alt="sticker.id" class="h-16 w-16 object-contain" loading="lazy" />
          </button>
        </div>
      </template>

      <!-- Empty state -->
      <div v-if="packs.length === 0" class="flex h-32 items-center justify-center text-sm text-text-on-main-bg-color/50">
        No sticker packs available
      </div>
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/StickerPicker.vue
git commit -m "feat: add StickerPicker component"
```

---

### Task 9: Refactor EmojiPicker to tabbed layout (Emoji | Stickers | GIF)

**Files:**
- Modify: `src/features/messaging/ui/EmojiPicker.vue`

This is the biggest change. The EmojiPicker becomes a unified picker with 3 tabs.

**Step 1: Add imports and tab state**

At the top of `<script setup>`, add:
```typescript
import EmojiKitchenBar from "./EmojiKitchenBar.vue";
import GifPicker from "./GifPicker.vue";
import StickerPicker from "./StickerPicker.vue";
import type { TenorGif } from "@/shared/lib/tenor";
import type { Sticker } from "@/shared/lib/sticker-packs";

type PickerTab = "emoji" | "stickers" | "gif";
const activeTab = ref<PickerTab>("emoji");
const lastSelectedEmoji = ref<string | null>(null);
```

Add new emits:
```typescript
const emit = defineEmits<{
  close: [];
  select: [emoji: string];
  selectSticker: [sticker: Sticker];
  selectGif: [gif: TenorGif];
  selectKitchen: [imageUrl: string];
}>();
```

**Step 2: Update handleSelect to track last emoji for Kitchen**

```typescript
const handleSelect = (emoji: string) => {
  lastSelectedEmoji.value = emoji;
  emit("select", emoji);
  if (props.mode === "reaction") {
    emit("close");
  }
};
```

**Step 3: Reset tab and kitchen state when picker opens**

In the existing `watch(() => props.show, ...)`:
```typescript
if (v) {
  search.value = "";
  activeCategoryIndex.value = 0;
  activeTab.value = "emoji";
  lastSelectedEmoji.value = null;
  // ... existing reset code
}
```

**Step 4: Add tab bar to template**

After the search bar, before category tabs, add the main tab switcher:

```html
<!-- Main tabs: Emoji | Stickers | GIF -->
<div class="flex shrink-0 border-b border-neutral-grad-0/50 px-2">
  <button
    v-for="tab in (['emoji', 'stickers', 'gif'] as const)"
    :key="tab"
    class="flex-1 py-1.5 text-center text-xs font-medium transition-colors"
    :class="activeTab === tab
      ? 'text-color-bg-ac border-b-2 border-color-bg-ac'
      : 'text-text-on-main-bg-color/60 hover:text-text-on-main-bg-color'"
    @click="activeTab = tab"
  >
    {{ tab === 'emoji' ? '😀' : tab === 'stickers' ? '🎨' : 'GIF' }}
  </button>
</div>
```

**Step 5: Wrap existing emoji content in v-if="activeTab === 'emoji'"**

The existing category tabs and emoji grid should only show when `activeTab === 'emoji'`.

**Step 6: Add Sticker and GIF tabs**

After the emoji grid section:
```html
<!-- Stickers tab -->
<StickerPicker
  v-if="activeTab === 'stickers'"
  class="min-h-0 flex-1"
  @select="(s) => { emit('selectSticker', s); if (props.mode === 'reaction') emit('close'); }"
/>

<!-- GIF tab -->
<GifPicker
  v-if="activeTab === 'gif'"
  class="min-h-0 flex-1"
  @select="(g) => { emit('selectGif', g); emit('close'); }"
/>
```

**Step 7: Add EmojiKitchenBar at bottom of emoji tab**

Inside the emoji tab section, after the grid and before closing the section:
```html
<EmojiKitchenBar
  v-if="activeTab === 'emoji' && props.mode === 'input'"
  :selected-emoji="lastSelectedEmoji"
  @select="(url) => { emit('selectKitchen', url); }"
/>
```

**Step 8: Commit**

```bash
git add src/features/messaging/ui/EmojiPicker.vue
git commit -m "feat: refactor EmojiPicker to tabbed layout with Stickers and GIF tabs"
```

---

### Task 10: Integrate new picker events in MessageInput

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`

**Step 1: Import sendSticker and sendGif**

Update the destructured imports from `useMessages()`:
```typescript
const { sendMessage, sendFile, sendImage, sendAudio, sendReply, editMessage, setTyping, sendPoll, sendSticker, sendGif } = useMessages();
```

**Step 2: Add handler functions**

After the existing `insertEmoji` function:

```typescript
const handleStickerSelect = async (sticker: { url: string }) => {
  showEmojiPicker.value = false;
  await sendSticker(sticker.url);
};

const handleGifSelect = async (gif: { gifUrl: string; width: number; height: number; title: string }) => {
  showEmojiPicker.value = false;
  await sendGif(gif.gifUrl, { w: gif.width, h: gif.height, title: gif.title });
};

const handleKitchenSelect = async (imageUrl: string) => {
  await sendSticker(imageUrl);
};
```

**Step 3: Add new events to EmojiPicker template**

Update the `<EmojiPicker>` usage in template (around line 581):

```html
<EmojiPicker
  :show="showEmojiPicker"
  :x="emojiPickerPos.x"
  :y="emojiPickerPos.y"
  mode="input"
  @close="showEmojiPicker = false"
  @select="insertEmoji"
  @select-sticker="handleStickerSelect"
  @select-gif="handleGifSelect"
  @select-kitchen="handleKitchenSelect"
/>
```

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue
git commit -m "feat: integrate sticker, GIF, and Emoji Kitchen sending in MessageInput"
```

---

### Task 11: Render stickers as borderless enlarged images in MessageBubble

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue`

**Step 1: Add sticker rendering block**

After the image message block (around line 305) and before the video block, add:

```html
<!-- Sticker message (borderless, enlarged) -->
<div
  v-else-if="message.type === MessageType.sticker"
  class="relative"
>
  <div v-if="fileState.loading" class="flex h-32 w-32 items-center justify-center">
    <div class="h-6 w-6 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
  </div>
  <img
    v-else-if="fileState.objectUrl"
    :src="fileState.objectUrl"
    alt="Sticker"
    class="max-h-40 max-w-40 object-contain drop-shadow-sm"
  />
  <img
    v-else-if="message.fileInfo?.url"
    :src="message.fileInfo.url"
    alt="Sticker"
    class="max-h-40 max-w-40 object-contain drop-shadow-sm"
  />
  <div v-if="themeStore.showTimestamps" class="mt-0.5 flex items-center gap-1" :class="props.isOwn ? 'justify-end text-text-on-main-bg-color' : 'text-text-on-main-bg-color'">
    <span class="text-[10px]">{{ time }}</span>
    <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
  </div>
  <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
</div>
```

**Step 2: Import MessageType.sticker**

The `MessageType` import already exists — just ensure `sticker` is handled.

**Step 3: Auto-download sticker like images**

In the `onMounted` hook (line 175), add sticker to the auto-download condition:
```typescript
if ((props.message.type === MessageType.image || props.message.type === MessageType.sticker) && props.message.fileInfo) {
  download(props.message);
}
```

Same for the watch on `message.id` (line 182).

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageBubble.vue
git commit -m "feat: render stickers as borderless enlarged images"
```

---

### Task 12: Create ReactionEffect component (fullscreen animations)

**Files:**
- Create: `src/features/messaging/ui/ReactionEffect.vue`

**Step 1: Create the fullscreen reaction animation component**

```vue
<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";

interface Props {
  emoji: string | null;
}

const props = defineProps<Props>();

interface Particle {
  id: number;
  emoji: string;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  rotation: number;
}

const particles = ref<Particle[]>([]);
let idCounter = 0;
let cleanupTimer: ReturnType<typeof setTimeout>;

const EFFECT_MAP: Record<string, { count: number; direction: "up" | "down" | "burst" }> = {
  "❤️": { count: 15, direction: "up" },
  "🔥": { count: 12, direction: "up" },
  "🎉": { count: 25, direction: "down" },
  "👍": { count: 1, direction: "burst" },
  "😂": { count: 12, direction: "down" },
};

const spawnEffect = (emoji: string) => {
  const config = EFFECT_MAP[emoji] ?? { count: 8, direction: "burst" };
  const newParticles: Particle[] = [];

  for (let i = 0; i < config.count; i++) {
    newParticles.push({
      id: ++idCounter,
      emoji,
      x: config.direction === "burst" ? 50 : Math.random() * 80 + 10,
      y: config.direction === "down" ? -10 : config.direction === "up" ? 110 : 50,
      size: config.direction === "burst" && config.count === 1 ? 72 : 20 + Math.random() * 16,
      delay: Math.random() * 0.4,
      duration: 1.2 + Math.random() * 0.8,
      rotation: Math.random() * 360,
    });
  }

  particles.value = [...particles.value, ...newParticles];

  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    particles.value = [];
  }, 2500);
};

watch(() => props.emoji, (emoji) => {
  if (emoji) spawnEffect(emoji);
});

onUnmounted(() => clearTimeout(cleanupTimer));
</script>

<template>
  <Teleport to="body">
    <div v-if="particles.length" class="pointer-events-none fixed inset-0 z-[100] overflow-hidden">
      <div
        v-for="p in particles"
        :key="p.id"
        class="absolute"
        :class="{
          'reaction-float-up': EFFECT_MAP[p.emoji]?.direction === 'up' || (!EFFECT_MAP[p.emoji] && true),
          'reaction-fall-down': EFFECT_MAP[p.emoji]?.direction === 'down',
          'reaction-burst': EFFECT_MAP[p.emoji]?.direction === 'burst',
        }"
        :style="{
          left: `${p.x}%`,
          top: `${p.y}%`,
          fontSize: `${p.size}px`,
          animationDelay: `${p.delay}s`,
          animationDuration: `${p.duration}s`,
          transform: `rotate(${p.rotation}deg)`,
        }"
      >
        {{ p.emoji }}
      </div>
    </div>
  </Teleport>
</template>

<style>
@keyframes float-up {
  0% { transform: translateY(0) scale(0.5); opacity: 0; }
  15% { opacity: 1; transform: translateY(-10vh) scale(1); }
  100% { transform: translateY(-120vh) scale(0.3) rotate(30deg); opacity: 0; }
}
@keyframes fall-down {
  0% { transform: translateY(0) scale(0.5); opacity: 0; }
  15% { opacity: 1; transform: translateY(10vh) scale(1); }
  100% { transform: translateY(120vh) scale(0.5) rotate(-20deg); opacity: 0; }
}
@keyframes burst-pop {
  0% { transform: scale(0); opacity: 0; }
  30% { transform: scale(1.5); opacity: 1; }
  60% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(0); opacity: 0; }
}

.reaction-float-up { animation: float-up var(--duration, 1.5s) ease-out forwards; }
.reaction-fall-down { animation: fall-down var(--duration, 1.5s) ease-in forwards; }
.reaction-burst { animation: burst-pop var(--duration, 1s) ease-out forwards; }
</style>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/ReactionEffect.vue
git commit -m "feat: add ReactionEffect fullscreen animation component"
```

---

### Task 13: Add `animatedReactions` setting to themeStore

**Files:**
- Modify: `src/entities/theme/model/stores.ts`

**Step 1: Add the setting**

Add after `animationsEnabled`:
```typescript
const animatedReactions = ref<boolean>(localStorage.getItem("animatedReactions") !== "false");

const setAnimatedReactions = (val: boolean) => {
  animatedReactions.value = val;
  localStorage.setItem("animatedReactions", String(val));
};
```

**Step 2: Export from store return**

Add `animatedReactions` and `setAnimatedReactions` to the store return object.

**Step 3: Commit**

```bash
git add src/entities/theme/model/stores.ts
git commit -m "feat: add animatedReactions setting to theme store"
```

---

### Task 14: Integrate ReactionEffect in MessageList

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue`

**Step 1: Import and add ReactionEffect**

Add import:
```typescript
import ReactionEffect from "./ReactionEffect.vue";
```

Add state:
```typescript
const lastReactionEmoji = ref<string | null>(null);
```

**Step 2: Wrap toggleReaction to trigger effect**

Modify the existing reaction handling. Find where `toggleReaction` is called (around line 789) and wrap it:

```typescript
const handleToggleReactionWithEffect = (messageId: string, emoji: string) => {
  toggleReaction(messageId, emoji);
  if (themeStore.animatedReactions) {
    lastReactionEmoji.value = emoji;
    // Reset after animation
    setTimeout(() => { lastReactionEmoji.value = null; }, 100);
  }
};
```

Also update `handleContextReaction`:
```typescript
const handleContextReaction = (emoji: string, message: import("@/entities/chat").Message) => {
  toggleReaction(message.id, emoji);
  themeStore.addRecentEmoji(emoji);
  if (themeStore.animatedReactions) {
    lastReactionEmoji.value = emoji;
    setTimeout(() => { lastReactionEmoji.value = null; }, 100);
  }
};
```

**Step 3: Add ReactionEffect to template**

Before the closing `</div>` of the main template (before the scroll FAB), add:
```html
<ReactionEffect :emoji="lastReactionEmoji" />
```

**Step 4: Update MessageBubble event handler**

In the `<MessageBubble>` tag, change:
```
@toggle-reaction="(emoji, messageId) => toggleReaction(messageId, emoji)"
```
to:
```
@toggle-reaction="(emoji, messageId) => handleToggleReactionWithEffect(messageId, emoji)"
```

**Step 5: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue
git commit -m "feat: integrate fullscreen reaction effects in MessageList"
```

---

### Task 15: Create TypingBubble component (wave animation)

**Files:**
- Create: `src/features/messaging/ui/TypingBubble.vue`

**Step 1: Create the wave-animated typing bubble**

```vue
<script setup lang="ts">
interface Props {
  names: string[];
}

defineProps<Props>();
</script>

<template>
  <div class="flex items-end gap-2">
    <div class="rounded-bubble rounded-bl-bubble-sm bg-chat-bubble-other px-3 py-2.5">
      <div class="flex items-center gap-1.5">
        <div class="flex gap-[3px]">
          <span class="typing-dot h-2 w-2 rounded-full bg-text-on-main-bg-color/50" style="animation-delay: 0ms" />
          <span class="typing-dot h-2 w-2 rounded-full bg-text-on-main-bg-color/50" style="animation-delay: 150ms" />
          <span class="typing-dot h-2 w-2 rounded-full bg-text-on-main-bg-color/50" style="animation-delay: 300ms" />
        </div>
        <span v-if="names.length" class="ml-1 text-xs text-text-on-main-bg-color/60">
          {{ names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}` }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes typing-wave {
  0%, 60%, 100% {
    transform: translateY(0) scale(1);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-6px) scale(1.15);
    opacity: 1;
  }
}

.typing-dot {
  animation: typing-wave 1.2s ease-in-out infinite;
}
</style>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/TypingBubble.vue
git commit -m "feat: add TypingBubble component with wave animation"
```

---

### Task 16: Replace inline typing indicator with TypingBubble in MessageList

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue`

**Step 1: Import TypingBubble**

```typescript
import TypingBubble from "./TypingBubble.vue";
```

**Step 2: Add computed for typing user names**

```typescript
const typingNames = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return [];
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  return typingUsers
    .filter(id => id !== myAddr)
    .map(id => chatStore.getDisplayName(id));
});
```

**Step 3: Replace the inline typing indicator**

Find the existing typing indicator in the template (around line 802):
```html
<!-- Typing indicator -->
<div v-else-if="item.type === 'typing'" class="mx-auto flex max-w-6xl items-center gap-2 px-10 py-1">
  <div class="flex gap-0.5">
    <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color [animation-delay:-0.3s]" />
    <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color [animation-delay:-0.15s]" />
    <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color" />
  </div>
  <span class="text-xs text-text-on-main-bg-color">{{ typingText }}</span>
</div>
```

Replace with:
```html
<!-- Typing bubble -->
<div v-else-if="item.type === 'typing'" class="mx-auto max-w-6xl px-4 py-1">
  <div class="flex gap-2">
    <div v-if="themeStore.showAvatarsInChat" class="w-8 shrink-0" />
    <TypingBubble :names="typingNames" />
  </div>
</div>
```

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue src/features/messaging/ui/TypingBubble.vue
git commit -m "feat: replace typing indicator with wave-animated TypingBubble"
```

---

### Task 17: Add animated reactions toggle to settings UI

**Files:**
- Find and modify the settings/appearance component (likely in `src/features/settings/` or `src/widgets/`)

**Step 1: Find the settings component**

Search for where `animationsEnabled` toggle is rendered — the `animatedReactions` toggle should go next to it.

**Step 2: Add toggle**

Add after the `animationsEnabled` toggle:
```html
<SettingsSection :title="t('settings.animatedReactions') || 'Animated Reactions'">
  <Toggle
    :model-value="themeStore.animatedReactions"
    @update:model-value="themeStore.setAnimatedReactions($event)"
  />
</SettingsSection>
```

**Step 3: Add i18n key if needed**

Add to the relevant locale file:
```
"settings.animatedReactions": "Animated Reactions"
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add animated reactions toggle to settings"
```

---

### Task 18: Handle sticker type in chat-store message parsing

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts`

**Step 1: Add sticker handling to room preview**

In the `matrixRoomToChatRoom` function, where message types are detected (around line 72-90), add handling for stickers. Stickers from Matrix come as `m.image` with `m.sticker` msgtype or custom content.

In the preview body section, handle sticker display:
```typescript
} else if (msgtype === "m.sticker" || (content as any)["m.sticker"]) {
  previewBody = "[sticker]";
  previewType = MessageType.sticker;
}
```

**Step 2: Add sticker handling in message parsing**

In the function that parses timeline events into Message objects, ensure sticker content type creates `MessageType.sticker` messages.

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "feat: handle sticker message type in chat store"
```

---

### Task 19: Final integration test and polish

**Step 1: Run the dev server**

```bash
npm run dev
```

**Step 2: Verify all features work**

Manual test checklist:
- [ ] Open emoji picker → 3 tabs visible (Emoji, Stickers, GIF)
- [ ] Select an emoji → Kitchen bar appears with combinations
- [ ] Click a Kitchen combo → sends as sticker image
- [ ] Switch to GIF tab → trending GIFs load
- [ ] Search GIFs → results appear
- [ ] Click a GIF → sends to chat
- [ ] Switch to Stickers tab → packs visible (may show empty if no assets)
- [ ] React to a message → fullscreen effect plays
- [ ] Toggle animated reactions off in settings → no effects
- [ ] Someone types → wave bubble appears instead of old dots
- [ ] Sticker messages render without bubble background

**Step 3: Fix any TypeScript errors**

Run: `npx vue-tsc --noEmit`

**Step 4: Run tests**

Run: `npm test`

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete youth chat pack - Emoji Kitchen, GIF, stickers, reactions, typing bubble"
```

---

## Summary

| Task | Feature | New Files | Modified Files |
|------|---------|-----------|----------------|
| 1 | Emoji Kitchen | - | package.json |
| 2 | Emoji Kitchen | emoji-kitchen.ts | - |
| 3 | GIF Search | tenor.ts | - |
| 4 | Stickers | sticker-packs.ts, manifest.json | - |
| 5 | Send functions | - | use-messages.ts, types.ts |
| 6 | Emoji Kitchen | EmojiKitchenBar.vue | - |
| 7 | GIF Search | GifPicker.vue | - |
| 8 | Stickers | StickerPicker.vue | - |
| 9 | Tabbed Picker | - | EmojiPicker.vue |
| 10 | Integration | - | MessageInput.vue |
| 11 | Stickers | - | MessageBubble.vue |
| 12 | Reactions | ReactionEffect.vue | - |
| 13 | Reactions | - | theme store |
| 14 | Reactions | - | MessageList.vue |
| 15 | Typing | TypingBubble.vue | - |
| 16 | Typing | - | MessageList.vue |
| 17 | Settings | - | settings UI |
| 18 | Stickers | - | chat-store.ts |
| 19 | Polish | - | various |

**Total: 8 new files, 8 modified files, 19 tasks**
