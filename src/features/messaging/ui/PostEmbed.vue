<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";
import { parseVideoUrl, fetchPeerTubeThumb } from "@/shared/lib/video-embed";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();

const post = ref<BastyonPostData | null>(null);
const loading = ref(true);
const error = ref(false);
const authorName = ref("");
const authorImage = ref("");
const peertubeThumb = ref("");

const videoInfo = computed(() => (post.value?.url ? parseVideoUrl(post.value.url) : null));
const resolvedThumbUrl = computed(() => peertubeThumb.value || videoInfo.value?.thumbUrl || "");

const firstImage = computed(() => {
  if (!post.value?.images?.length) return null;
  return normalizePocketnetImageUrl(post.value.images[0]);
});

const truncatedMessage = computed(() => {
  if (!post.value?.message) return "";
  return post.value.message.length > 160
    ? post.value.message.slice(0, 160) + "..."
    : post.value.message;
});

const isArticle = computed(() => post.value?.settings?.v === "a");

const postUrl = computed(() => `bastyon://post?s=${props.txid}`);

onMounted(async () => {
  try {
    const data = await authStore.loadPost(props.txid);
    if (!data) {
      error.value = true;
      return;
    }
    post.value = data;

    // Fetch PeerTube thumbnail
    const vi = data.url ? parseVideoUrl(data.url) : null;
    if (vi?.type === "peertube" && vi.apiUrl) {
      fetchPeerTubeThumb(vi.apiUrl).then(url => { peertubeThumb.value = url; });
    }

    if (data.address) {
      await authStore.loadUsersInfo([data.address]);
      const user = authStore.getBastyonUserData(data.address);
      if (user) {
        authorName.value = user.name || data.address.slice(0, 10);
        authorImage.value = user.image || "";
      } else {
        authorName.value = data.address.slice(0, 10);
      }
    }
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});

const authorAvatarUrl = computed(() => normalizePocketnetImageUrl(authorImage.value));

const openPost = () => {
  window.open(postUrl.value, "_blank");
};

const openVideo = (e: Event) => {
  e.stopPropagation();
  if (post.value?.url) {
    window.open(post.value.url, "_blank");
  }
};
</script>

<template>
  <!-- Loading skeleton -->
  <div
    v-if="loading"
    class="my-1 flex w-full max-w-md items-center gap-3 rounded-xl p-3"
    :class="isOwn ? 'bg-white/10' : 'bg-neutral-grad-0/60'"
  >
    <div class="h-4 w-4 animate-pulse rounded-full bg-current opacity-20" />
    <span class="text-xs opacity-50">{{ t("post.loading") }}</span>
  </div>

  <!-- Error fallback -->
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
    class="group my-1 w-full max-w-md cursor-pointer overflow-hidden rounded-xl transition-shadow hover:shadow-lg"
    :class="isOwn ? 'bg-white/10 hover:bg-white/[0.14]' : 'bg-neutral-grad-0/60 hover:bg-neutral-grad-0/80'"
    @click="openPost"
  >
    <!-- Video thumbnail -->
    <div v-if="videoInfo && resolvedThumbUrl" class="relative">
      <img
        :src="resolvedThumbUrl"
        alt=""
        class="h-40 w-full object-cover"
        loading="lazy"
      />
      <button
        class="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20"
        @click="openVideo"
      >
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#000">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    </div>

    <!-- First image (if no video) -->
    <img
      v-else-if="firstImage"
      :src="firstImage"
      alt=""
      class="max-h-52 w-full object-cover"
      loading="lazy"
    />

    <div class="flex flex-col gap-1.5 p-3">
      <!-- Author row -->
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
        >
          {{ authorName.charAt(0).toUpperCase() }}
        </div>
        <span
          class="text-xs font-medium"
          :class="isOwn ? 'text-white/80' : 'text-text-color'"
        >{{ authorName }}</span>
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

      <!-- Message body -->
      <div
        v-if="truncatedMessage"
        class="text-xs leading-relaxed"
        :class="isOwn ? 'text-white/70' : 'text-text-color/70'"
      >
        {{ truncatedMessage }}
        <a
          v-if="post.message.length > 160"
          :href="postUrl"
          class="font-medium"
          :class="isOwn ? 'text-white/90' : 'text-color-txt-ac'"
          @click.stop
        >{{ t("post.readMore") }}</a>
      </div>

      <!-- Tags -->
      <div v-if="post.tags.length" class="flex flex-wrap gap-1">
        <span
          v-for="tag in post.tags.slice(0, 5)"
          :key="tag"
          class="rounded-full px-1.5 py-0.5 text-[10px]"
          :class="isOwn ? 'bg-white/10 text-white/60' : 'bg-color-bg-ac/10 text-color-bg-ac/60'"
        >#{{ tag }}</span>
      </div>

      <!-- Open link -->
      <div
        class="flex items-center gap-1 text-[10px] transition-opacity group-hover:opacity-100"
        :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color opacity-70'"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        {{ t("post.openInBastyon") }}
      </div>
    </div>
  </div>
</template>
