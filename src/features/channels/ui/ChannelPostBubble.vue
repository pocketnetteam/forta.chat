<script setup lang="ts">
import type { ChannelPost } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";
import { renderArticleText } from "@/shared/lib/article-blocks";
import StarRating from "@/features/post-player/ui/StarRating.vue";

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
  return props.post.images.slice(0, 4).map((img) => normalizePocketnetImageUrl(img));
});

/** Caption displayed separately when both caption and message exist. */
const captionText = computed(() => {
  if (!props.post.caption || !props.post.message) return "";
  return props.post.caption;
});

/**
 * Body text preview. Uses shared Editor.js parser so article posts
 * render readable plain text instead of raw JSON. Falls back to raw
 * for non-article messages.
 */
const bodyText = computed(() => {
  const raw = props.post.caption && props.post.message
    ? props.post.message
    : props.post.caption || props.post.message || "";
  if (!raw) return "";
  return renderArticleText(raw, { maxLength: 500 });
});

const averageScore = computed(() => {
  const cnt = props.post.scoreCnt ?? 0;
  if (cnt <= 0) return 0;
  return (props.post.scoreSum ?? 0) / cnt;
});
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

        <!-- Score (community average — outline gold when not voted) -->
        <StarRating
          v-if="post.scoreCnt > 0"
          :average="averageScore"
          :total-votes="post.scoreCnt"
          :model-value="null"
          readonly
          compact
        />

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
