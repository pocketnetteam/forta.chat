<script setup lang="ts">
import type { ChannelPost } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";

interface Props {
  post: ChannelPost;
  channelName?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  openPost: [txid: string];
  openComments: [txid: string];
}>();

const timeText = computed(() =>
  formatRelativeTime(new Date(props.post.time * 1000))
);

const isArticle = computed(() =>
  props.post.type === "article" || props.post.settings?.v === "a"
);

const isVideo = computed(() =>
  props.post.type === "video" && (!props.post.images || props.post.images.length === 0)
);

const displayImages = computed(() => {
  if (!props.post.images || props.post.images.length === 0) return [];
  return props.post.images.slice(0, 4).map((img) =>
    img.startsWith("http") ? img : `https://bastyon.com/images/${img}`
  );
});

/** Parse message text — for articles (EditorJS JSON), extract paragraph text */
const messageText = computed(() => {
  const raw = props.post.caption || props.post.message || "";
  if (!raw) return "";

  // If article, try to parse EditorJS JSON
  if (isArticle.value && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        const texts = parsed.blocks
          .filter((b: any) => b.type === "paragraph" && b.data?.text)
          .map((b: any) => stripHtml(b.data.text))
          .filter(Boolean);
        return texts.join("\n").slice(0, 500);
      }
    } catch {
      // Not valid JSON, use as-is
    }
  }

  return raw;
});

/** Caption displayed separately when both caption and message exist */
const captionText = computed(() => {
  if (!props.post.caption || !props.post.message) return "";
  return props.post.caption;
});

/** Body text: message when caption exists, or the combined text */
const bodyText = computed(() => {
  if (props.post.caption && props.post.message) {
    // For articles, parse message as EditorJS
    if (isArticle.value && props.post.message.startsWith("{")) {
      try {
        const parsed = JSON.parse(props.post.message);
        if (parsed.blocks && Array.isArray(parsed.blocks)) {
          const texts = parsed.blocks
            .filter((b: any) => b.type === "paragraph" && b.data?.text)
            .map((b: any) => stripHtml(b.data.text))
            .filter(Boolean);
          return texts.join("\n").slice(0, 500);
        }
      } catch {
        // fallback
      }
    }
    return props.post.message;
  }
  return messageText.value;
});

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}
</script>

<template>
  <div class="flex w-full px-3 py-1.5">
    <div
      class="max-w-[85%] cursor-pointer rounded-2xl rounded-tl-sm bg-neutral-grad-0 px-3 py-2"
      @click="emit('openPost', post.txid)"
    >
      <!-- Caption -->
      <div
        v-if="captionText"
        class="mb-1 text-sm font-semibold leading-snug text-text-color"
      >
        {{ captionText }}
      </div>

      <!-- Images -->
      <div
        v-if="displayImages.length === 1"
        class="mb-2 overflow-hidden rounded-lg"
      >
        <img
          :src="displayImages[0]"
          alt=""
          class="max-h-60 w-full object-cover"
          loading="lazy"
        />
      </div>
      <div
        v-else-if="displayImages.length > 1"
        class="mb-2 grid grid-cols-2 gap-1 overflow-hidden rounded-lg"
      >
        <img
          v-for="(img, idx) in displayImages"
          :key="idx"
          :src="img"
          alt=""
          class="h-32 w-full object-cover"
          loading="lazy"
        />
      </div>

      <!-- Video indicator -->
      <div
        v-if="isVideo"
        class="mb-2 flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="text-color-bg-ac">
          <path d="M8 5v14l11-7z" />
        </svg>
        <span class="text-sm text-text-color">Video</span>
      </div>

      <!-- Article badge -->
      <div
        v-if="isArticle"
        class="mb-2 flex items-center gap-2"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-color-bg-ac">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span class="text-xs font-medium text-color-bg-ac">Article</span>
      </div>

      <!-- Message text -->
      <div
        v-if="bodyText"
        class="whitespace-pre-wrap break-words text-sm text-text-color"
      >
        {{ bodyText.length > 300 ? bodyText.slice(0, 300) + '...' : bodyText }}
      </div>

      <!-- Footer -->
      <div class="mt-1.5 flex items-center gap-3 text-xs text-text-on-main-bg-color">
        <span>{{ timeText }}</span>

        <!-- Score -->
        <span v-if="post.scoreSum" class="flex items-center gap-0.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
            <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z" />
          </svg>
          {{ post.scoreSum }}
        </span>

        <!-- Comments -->
        <button
          v-if="post.comments > 0"
          class="flex items-center gap-0.5 hover:text-color-bg-ac transition-colors"
          @click.stop="emit('openComments', post.txid)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {{ post.comments }}
        </button>
      </div>
    </div>
  </div>
</template>
