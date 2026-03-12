<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";
import { parseVideoUrl } from "@/shared/lib/video-embed";
import { usePostScores } from "../model/use-post-scores";
import { usePostBoost } from "../model/use-post-boost";
import { useToast } from "@/shared/lib/use-toast";
import VideoPlayer from "./VideoPlayer.vue";
import StarRating from "./StarRating.vue";
import PostPlayerModal from "./PostPlayerModal.vue";
import SharePostPicker from "./SharePostPicker.vue";
import DonateModal from "@/features/wallet/ui/DonateModal.vue";

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();
const { toast } = useToast();

// Post scores — interactive voting from card
const { myScore, averageScore, totalVotes, hasVoted, submitting, load: loadScores, submitVote } = usePostScores(props.txid);

// Boost
const { showDonateModal, boostAddress, openBoost, closeBoost } = usePostBoost();

// Open user profile (provided by ChatWindow)
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

// Try sync cache first — avoids skeleton flash for prefetched posts
const cached = authStore.getCachedPost(props.txid);
const post = ref<BastyonPostData | null>(cached);
const loading = ref(!cached);
const error = ref(false);
const authorName = ref("");
const authorImage = ref("");
const authorReputation = ref<number | null>(null);
const showModal = ref(false);
const showSharePicker = ref(false);

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

const postUrl = computed(() => `bastyon://post?s=${props.txid}`);
const postLink = computed(() => `https://bastyon.com/post?s=${props.txid}`);
const isOwnPost = computed(() => post.value?.address === authStore.address);

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

function onVote(value: number) {
  submitVote(value);
  toast(t("postPlayer.rated"), "success");
}

function onShare() {
  showSharePicker.value = true;
}

function onBoost() {
  if (post.value?.address) {
    openBoost(post.value.address);
  }
}

function onAuthorClick() {
  if (post.value?.address && openUserProfile) {
    openUserProfile(post.value.address);
  }
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
    loadScores().catch(() => {});
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
    <!-- Author skeleton -->
    <div class="flex items-center gap-3 p-4 pb-3">
      <div class="h-12 w-12 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
      <div class="flex flex-col gap-1.5">
        <div class="h-4 w-28 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-3 w-20 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>
    <!-- Media skeleton -->
    <div class="aspect-video w-full animate-pulse bg-neutral-grad-2" />
    <!-- Content skeleton -->
    <div class="flex flex-col gap-2 px-4 pt-3">
      <div class="h-5 w-3/4 animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-4 w-full animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-4 w-2/3 animate-pulse rounded bg-neutral-grad-2" />
    </div>
    <!-- Rating skeleton -->
    <div class="flex items-center gap-3 px-4 py-4">
      <div class="flex gap-0.5">
        <div v-for="i in 5" :key="i" class="h-5 w-5 animate-pulse rounded bg-neutral-grad-2" />
      </div>
      <div class="h-3 w-8 animate-pulse rounded bg-neutral-grad-2" />
    </div>
    <!-- Button skeleton -->
    <div class="px-4 pb-4">
      <div class="h-10 w-full animate-pulse rounded-xl bg-neutral-grad-2" />
    </div>
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
    <!-- Author header — clickable to open profile -->
    <div
      class="flex cursor-pointer items-center gap-3 p-4 pb-3"
      @click.stop="onAuthorClick"
    >
      <!-- Avatar -->
      <img
        v-if="authorAvatarUrl"
        :src="authorAvatarUrl"
        alt=""
        class="h-12 w-12 shrink-0 rounded-full object-cover"
      />
      <div
        v-else
        class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <template v-if="authorName">{{ authorName.charAt(0).toUpperCase() }}</template>
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
      </div>

      <div class="flex min-w-0 flex-col">
        <div class="flex items-baseline gap-1">
          <span class="truncate font-bold" :class="isOwn ? 'text-white' : 'text-text-color'">
            {{ authorName }}
          </span>
          <sup
            v-if="formattedReputation"
            class="text-[10px] font-medium"
            :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'"
          >{{ formattedReputation }}</sup>
        </div>
        <span v-if="postDate" class="text-xs" :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">
          {{ postDate }}
        </span>
      </div>
    </div>

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

    <!-- Content section -->
    <div class="flex flex-col gap-2 px-4 pt-3">
      <!-- Caption -->
      <div
        v-if="post.caption"
        class="text-base font-semibold leading-snug"
        :class="isOwn ? 'text-white' : 'text-text-color'"
      >{{ post.caption }}</div>

      <!-- Message -->
      <div
        v-if="truncatedMessage"
        class="text-[13px] leading-relaxed"
        :class="isOwn ? 'text-white/80' : 'text-text-color/80'"
      >{{ truncatedMessage }}</div>

      <!-- Tags -->
      <div v-if="visibleTags.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="tag in visibleTags"
          :key="tag"
          class="rounded-full px-2.5 py-1 text-xs font-medium"
          :class="isOwn ? 'bg-white/10 text-white/70' : 'bg-neutral-grad-0 text-text-color/80'"
        >#{{ tag }}</span>
      </div>
    </div>

    <!-- Rating + actions row -->
    <div class="flex items-center gap-3 px-4 py-4" @click.stop @pointerdown.stop @touchstart.stop>
      <!-- Interactive star rating -->
      <StarRating
        :model-value="myScore"
        :average="averageScore"
        :total-votes="totalVotes"
        :readonly="hasVoted"
        :submitting="submitting"
        @update:model-value="onVote"
      />

      <!-- Votes count badge -->
      <div
        v-if="totalVotes > 0"
        class="flex items-center gap-1 rounded-full border px-2.5 py-1"
        :class="isOwn ? 'border-white/20 text-white/60' : 'border-neutral-grad-1 text-text-on-main-bg-color'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
        </svg>
        <span class="text-xs font-medium">{{ totalVotes }}</span>
      </div>

      <div class="flex-1" />

      <!-- Share -->
      <button
        :aria-label="t('postPlayer.share')"
        class="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
        :class="isOwn ? 'text-white/50 hover:bg-white/10 hover:text-white/80' : 'text-text-on-main-bg-color hover:bg-neutral-grad-0 hover:text-text-color'"
        @click.stop="onShare"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </button>

      <!-- Boost -->
      <button
        v-if="!isOwnPost"
        :aria-label="t('postPlayer.boost')"
        class="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
        :class="isOwn ? 'text-white/50 hover:bg-white/10 hover:text-white/80' : 'text-color-star-yellow hover:bg-color-star-yellow/10'"
        @click.stop="onBoost"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </button>
    </div>

    <!-- Open button -->
    <div class="px-4 pb-4">
      <button
        class="w-full rounded-xl py-2.5 text-sm font-semibold text-white transition-colors"
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

  <!-- Share picker -->
  <SharePostPicker
    v-if="showSharePicker"
    :show="showSharePicker"
    :post-link="postLink"
    :post-title="post?.caption || ''"
    @close="showSharePicker = false"
  />

  <!-- Donate modal for boost -->
  <DonateModal
    :show="showDonateModal"
    :receiver-address="boostAddress"
    :receiver-name="authorName"
    @close="closeBoost"
  />
</template>
