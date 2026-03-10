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
  return post.value.message.length > 120
    ? post.value.message.slice(0, 120) + "..."
    : post.value.message;
});

const authorAvatarUrl = computed(() => {
  if (!authorImage.value) return "";
  return authorImage.value.startsWith("http")
    ? authorImage.value
    : `https://bastyon.com/images/${authorImage.value}`;
});

const scores = ref<{ average: number; total: number }>({ average: 0, total: 0 });

async function loadAuthor(data: BastyonPostData) {
  if (!data.address) return;
  await authStore.loadUsersInfo([data.address]);
  const user = authStore.getBastyonUserData(data.address);
  if (user) {
    authorName.value = user.name || data.address.slice(0, 10);
    authorImage.value = user.image || "";
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
  });
}

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
    class="post-card my-1 w-full max-w-md overflow-hidden rounded-xl"
    :class="isOwn ? 'bg-white/10' : 'bg-neutral-grad-0/60'"
  >
    <div class="h-36 w-full animate-pulse bg-neutral-grad-2" />
    <div class="flex flex-col gap-2 p-3">
      <div class="flex items-center gap-2">
        <div class="h-5 w-5 animate-pulse rounded-full bg-neutral-grad-2" />
        <div class="h-3 w-20 animate-pulse rounded bg-neutral-grad-2" />
      </div>
      <div class="h-4 w-3/4 animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-3 w-1/2 animate-pulse rounded bg-neutral-grad-2" />
    </div>
  </div>

  <!-- Error -->
  <a
    v-else-if="error"
    :href="`bastyon://post?s=${txid}`"
    target="_blank"
    rel="noopener noreferrer"
    class="text-color-txt-ac underline hover:no-underline"
    @click.stop
  >{{ t("post.notFound") }}</a>

  <!-- Post card -->
  <div
    v-else-if="post"
    class="post-card group my-1 w-full max-w-md cursor-pointer overflow-hidden rounded-xl transition-shadow hover:shadow-lg"
    :class="isOwn ? 'bg-white/10 hover:bg-white/[0.14]' : 'bg-neutral-grad-0/60 hover:bg-neutral-grad-0/80'"
    @click="showModal = true"
  >
    <!-- Inline video -->
    <VideoPlayer v-if="videoInfo" :url="post.url" inline />

    <!-- Image -->
    <img
      v-else-if="firstImage"
      :src="firstImage"
      alt=""
      class="max-h-52 w-full object-cover"
      loading="lazy"
    />

    <div class="flex flex-col gap-1.5 p-3">
      <!-- Author -->
      <div v-if="authorName" class="flex items-center gap-2">
        <img
          v-if="authorAvatarUrl"
          :src="authorAvatarUrl"
          alt=""
          class="h-5 w-5 rounded-full object-cover"
        />
        <div
          v-else
          class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
          :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
        >{{ authorName.charAt(0).toUpperCase() }}</div>
        <span class="text-xs font-medium" :class="isOwn ? 'text-white/80' : 'text-text-color'">
          {{ authorName }}
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

      <!-- Caption -->
      <div
        v-if="post.caption"
        class="text-sm font-semibold leading-snug"
        :class="isOwn ? 'text-white' : 'text-text-color'"
      >{{ post.caption }}</div>

      <!-- Message -->
      <div
        v-if="truncatedMessage"
        class="text-xs leading-relaxed"
        :class="isOwn ? 'text-white/70' : 'text-text-color/70'"
      >{{ truncatedMessage }}</div>

      <!-- Compact rating + open hint -->
      <div class="flex items-center justify-between pt-1">
        <StarRating
          :average="scores.average"
          :total-votes="scores.total"
          compact
          readonly
        />
        <span
          class="text-[10px] transition-opacity group-hover:opacity-100"
          :class="isOwn ? 'text-white/60 group-hover:text-white/80' : 'text-text-on-main-bg-color opacity-70'"
        >
          {{ t("postPlayer.openPost") }}
        </span>
      </div>
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
