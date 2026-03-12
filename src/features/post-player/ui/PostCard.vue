<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";
import { parseVideoUrl } from "@/shared/lib/video-embed";
import VideoPlayer from "./VideoPlayer.vue";
import StarRating from "./StarRating.vue";
import PostPlayerModal from "./PostPlayerModal.vue";

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();

// Try sync cache first — avoids skeleton flash for prefetched posts
const cached = authStore.getCachedPost(props.txid);
const post = ref<BastyonPostData | null>(cached);
const loading = ref(!cached);
const error = ref(false);
const authorName = ref("");
const authorImage = ref("");
const authorReputation = ref<number | null>(null);
const showModal = ref(false);

const videoInfo = computed(() => post.value?.url ? parseVideoUrl(post.value.url) : null);
const isArticle = computed(() => post.value?.settings?.v === "a");

const firstImage = computed(() => {
  if (!post.value?.images?.length) return null;
  const img = post.value.images[0];
  return img.startsWith("http") ? img : `https://bastyon.com/images/${img}`;
});

const truncatedMessage = computed(() => {
  if (!post.value?.message) return "";
  return post.value.message.length > 500
    ? post.value.message.slice(0, 500) + "..."
    : post.value.message;
});

const authorAvatarUrl = computed(() => {
  if (!authorImage.value) return "";
  return authorImage.value.startsWith("http")
    ? authorImage.value
    : `https://bastyon.com/images/${authorImage.value}`;
});

const formattedReputation = computed(() => {
  if (authorReputation.value == null) return "";
  const rep = authorReputation.value;
  if (rep >= 1000) return (rep / 1000).toFixed(1) + "K";
  return rep.toFixed(0);
});

const postDate = computed(() => {
  if (!post.value?.time) return "";
  const date = new Date(post.value.time * 1000);
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
});

const visibleTags = computed(() => {
  if (!post.value?.tags?.length) return [];
  return post.value.tags.slice(0, 5);
});

const scores = ref<{ average: number; total: number }>({ average: 0, total: 0 });

async function loadAuthor(data: BastyonPostData) {
  if (!data.address) return;
  await authStore.loadUsersInfo([data.address]);
  const user = authStore.getBastyonUserData(data.address);
  if (user) {
    authorName.value = user.name || data.address.slice(0, 10);
    authorImage.value = user.image || "";
    authorReputation.value = user.reputation ?? null;
  } else {
    authorName.value = data.address.slice(0, 10);
  }
}

function loadScores() {
  authStore.loadPostScores(props.txid).then((s) => {
    if (s.length) {
      const sum = s.reduce((a, x) => a + x.value, 0);
      scores.value = { average: sum / s.length, total: s.length };
    }
  }).catch(() => { /* scores unavailable, non-fatal */ });
}

const postUrl = computed(() => `bastyon://post?s=${props.txid}`);

onMounted(async () => {
  try {
    let data = post.value;
    if (!data) {
      data = await authStore.loadPost(props.txid);
      if (!data) { error.value = true; return; }
      post.value = data;
    }
    await loadAuthor(data);
    loadScores();
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!-- Loading skeleton -->
  <div
    v-if="loading"
    class="post-card my-1.5 w-full max-w-md overflow-hidden rounded-2xl border"
    :class="isOwn ? 'border-white/10 bg-white/10' : 'border-neutral-grad-1/50 bg-background-total-theme'"
  >
    <div class="flex items-center gap-3 p-4 pb-2">
      <div class="h-10 w-10 animate-pulse rounded-full bg-neutral-grad-2" />
      <div class="flex flex-col gap-1.5">
        <div class="h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-2.5 w-16 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>
    <div class="flex flex-col gap-2 px-4 pb-3">
      <div class="h-4 w-full animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-4 w-3/4 animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-3 w-1/2 animate-pulse rounded bg-neutral-grad-2" />
    </div>
    <div class="h-40 w-full animate-pulse bg-neutral-grad-2" />
  </div>

  <!-- Error -->
  <a
    v-else-if="error"
    :href="postUrl"
    target="_blank"
    rel="noopener noreferrer"
    class="text-color-txt-ac underline hover:no-underline"
    @click.stop
  >{{ t("post.notFound") }}</a>

  <!-- Post card -->
  <div
    v-else-if="post"
    class="post-card my-1.5 w-full max-w-md overflow-hidden rounded-2xl border"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
  >
    <!-- Author header -->
    <div class="flex items-center gap-3 p-4 pb-3">
      <img
        v-if="authorAvatarUrl"
        :src="authorAvatarUrl"
        alt=""
        class="h-10 w-10 shrink-0 rounded-full object-cover"
      />
      <div
        v-else
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <template v-if="authorName">{{ authorName.charAt(0).toUpperCase() }}</template>
        <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
      </div>

      <div class="flex min-w-0 flex-col">
        <div class="flex items-baseline gap-1">
          <span class="truncate text-sm font-semibold" :class="isOwn ? 'text-white' : 'text-text-color'">
            {{ authorName }}
          </span>
          <span
            v-if="formattedReputation"
            class="shrink-0 text-[10px] font-medium"
            :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'"
          >{{ formattedReputation }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span v-if="postDate" class="text-xs" :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">
            {{ postDate }}
          </span>
          <span
            v-if="isArticle"
            class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            :class="isOwn ? 'bg-white/15 text-white/70' : 'bg-color-bg-ac/15 text-color-bg-ac'"
          >{{ t("post.article") }}</span>
          <span
            v-else-if="videoInfo"
            class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            :class="isOwn ? 'bg-white/15 text-white/70' : 'bg-color-bg-ac/15 text-color-bg-ac'"
          >{{ t("post.video") }}</span>
        </div>
      </div>
    </div>

    <!-- Caption -->
    <div
      v-if="post.caption"
      class="px-4 pb-1 text-sm font-semibold leading-snug"
      :class="isOwn ? 'text-white' : 'text-text-color'"
    >{{ post.caption }}</div>

    <!-- Message -->
    <div
      v-if="truncatedMessage"
      class="px-4 pb-3 text-[13px] leading-relaxed"
      :class="isOwn ? 'text-white/80' : 'text-text-color/80'"
    >{{ truncatedMessage }}</div>

    <!-- Inline video -->
    <VideoPlayer v-if="videoInfo" :url="post.url" inline />

    <!-- Image -->
    <img
      v-else-if="firstImage"
      :src="firstImage"
      alt=""
      class="w-full object-cover"
      loading="lazy"
    />

    <!-- Tags -->
    <div v-if="visibleTags.length" class="flex flex-wrap gap-1.5 px-4 pt-3">
      <span
        v-for="tag in visibleTags"
        :key="tag"
        class="text-xs"
        :class="isOwn ? 'text-white/50' : 'text-color-txt-ac'"
      >#{{ tag }}</span>
    </div>

    <!-- Rating footer -->
    <div class="px-4 py-3">
      <StarRating
        :average="scores.average"
        :total-votes="scores.total"
        readonly
      />
    </div>

    <!-- Open button -->
    <div class="border-t px-4 py-2.5" :class="isOwn ? 'border-white/10' : 'border-neutral-grad-1/50'">
      <button
        class="w-full rounded-lg py-2 text-sm font-medium text-white transition-colors"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        @click.stop="showModal = true"
      >
        {{ t("postPlayer.openPost") }}
      </button>
    </div>
  </div>

  <!-- Modal -->
  <PostPlayerModal
    v-if="showModal && post"
    :post="post"
    :author-name="authorName"
    :author-avatar-url="authorAvatarUrl"
    @close="showModal = false"
  />
</template>
