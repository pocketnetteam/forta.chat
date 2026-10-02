<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonCollectionData } from "@/shared/lib/bastyon-collection";
import { toBastyonCollectionHttpsUrl } from "@/shared/lib/bastyon-link";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import { withTimeout } from "@/shared/lib/with-timeout";

// Same bound as PostCard: on slow networks (Tor) the load can hang, after this
// the skeleton turns into an error state with a retry button.
const COLLECTION_LOAD_TIMEOUT_MS = 15_000;

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();

// Open user profile (provided by ChatWindow)
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

// Only the collection itself is loaded (cover, caption, description, author,
// count) — its publications are never requested for the preview.
const cached = authStore.getCachedCollection(props.txid);
const collection = ref<BastyonCollectionData | null>(cached);
const loading = ref(!cached);
const error = ref(false);
const authorName = ref("");
const authorImage = ref("");
const authorAvatarError = ref(false);
const coverError = ref(false);

const coverUrl = computed(() => {
  if (!collection.value?.image || coverError.value) return "";
  return normalizePocketnetImageUrl(collection.value.image);
});
const authorAvatarUrl = computed(() => normalizePocketnetImageUrl(authorImage.value));
const collectionUrl = computed(() => toBastyonCollectionHttpsUrl(props.txid));

async function loadAuthor(data: BastyonCollectionData) {
  if (!data.address) return;
  try {
    await authStore.loadUsersInfo([data.address]);
  } catch {
    // name falls back to the address below
  }
  const user = authStore.getBastyonUserData(data.address);
  authorName.value = user?.name || data.address.slice(0, 10);
  authorImage.value = user?.image || "";
}

async function loadCollectionData() {
  loading.value = true;
  error.value = false;
  try {
    let data = collection.value;
    if (!data) {
      data = await withTimeout(authStore.loadCollection(props.txid), COLLECTION_LOAD_TIMEOUT_MS, "loadCollection");
      if (!data) { error.value = true; return; }
      collection.value = data;
    }
    await loadAuthor(data);
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
}

function onAuthorClick() {
  if (collection.value?.address && openUserProfile) {
    openUserProfile(collection.value.address);
  }
}

function onOpen() {
  void openExternalUrl(collectionUrl.value);
}

onMounted(loadCollectionData);
</script>

<template>
  <!-- Loading skeleton — matches loaded card dimensions to prevent layout shift -->
  <div
    v-if="loading"
    class="collection-card my-1.5 w-[20rem] max-w-full overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/10' : 'border-neutral-grad-1/50 bg-background-total-theme'"
  >
    <div class="flex items-center gap-3 p-3 sm:p-4">
      <div class="h-16 w-16 shrink-0 animate-pulse rounded-xl bg-neutral-grad-2" />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="h-3 w-16 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-4 w-3/4 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-3 w-1/2 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>
    <div class="px-3 pb-3 sm:px-4 sm:pb-4">
      <div class="h-9 w-full animate-pulse rounded-xl bg-neutral-grad-2 sm:h-10" />
    </div>
  </div>

  <!-- Error -->
  <div v-else-if="error || !collection" class="flex items-center gap-3 py-1">
    <a
      :href="collectionUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="text-color-txt-ac underline hover:no-underline"
      @click.stop.prevent="onOpen"
    >{{ t("collection.notFound") }}</a>
    <button
      class="rounded-lg border border-neutral-grad-1/50 px-2.5 py-1 text-xs font-medium text-text-color transition-colors hover:bg-neutral-grad-0"
      @click.stop="loadCollectionData"
    >{{ t("post.retry") }}</button>
  </div>

  <!-- Deleted collection -->
  <div
    v-else-if="collection.deleted"
    class="collection-card my-1.5 w-[20rem] max-w-full rounded-2xl border px-3 py-2.5 text-xs sm:w-[28rem] sm:px-4"
    :class="isOwn ? 'border-white/10 bg-white/[0.08] text-white/70' : 'border-neutral-grad-1/50 bg-background-total-theme text-text-on-main-bg-color'"
  >{{ t("collection.deleted") }}</div>

  <!-- Collection card -->
  <div
    v-else
    class="collection-card my-1.5 w-[20rem] max-w-full overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
  >
    <div class="flex items-center gap-3 p-3 pb-2 sm:p-4 sm:pb-3">
      <!-- Cover -->
      <img
        v-if="coverUrl"
        :src="coverUrl"
        alt=""
        class="h-16 w-16 shrink-0 rounded-xl object-cover"
        loading="lazy"
        @error="coverError = true"
      />
      <div
        v-else
        class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
      </div>

      <div class="flex min-w-0 flex-col gap-0.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-wider"
          :class="isOwn ? 'text-white/60' : 'text-color-txt-ac'"
        >{{ t("collection.label") }}</span>
        <span
          v-if="collection.caption"
          class="line-clamp-2 select-text text-sm font-semibold leading-snug sm:text-base"
          :class="isOwn ? 'text-white' : 'text-text-color'"
        >{{ collection.caption }}</span>
        <span
          class="text-[11px] sm:text-xs"
          :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'"
        >{{ t("collection.publicationsCount", { count: collection.contentCount }) }}</span>
      </div>
    </div>

    <!-- Description -->
    <div
      v-if="collection.description"
      class="line-clamp-3 select-text whitespace-pre-wrap break-words px-3 text-xs leading-relaxed sm:px-4 sm:text-[13px]"
      :class="isOwn ? 'text-white/80' : 'text-text-color/80'"
    >{{ collection.description }}</div>

    <!-- Author — clickable to open profile -->
    <div
      v-if="authorName"
      class="flex cursor-pointer items-center gap-2 px-3 pt-2 sm:px-4 sm:pt-3"
      @click.stop="onAuthorClick"
    >
      <img
        v-if="authorAvatarUrl && !authorAvatarError"
        :src="authorAvatarUrl"
        alt=""
        class="h-6 w-6 shrink-0 rounded-full object-cover"
        @error="authorAvatarError = true"
      />
      <div
        v-else
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >{{ authorName.charAt(0).toUpperCase() }}</div>
      <span
        class="truncate text-xs font-semibold"
        :class="isOwn ? 'text-white' : 'text-text-color'"
      >{{ authorName }}</span>
    </div>

    <!-- Open button -->
    <div class="p-3 sm:p-4">
      <button
        class="w-full rounded-xl py-2 text-xs font-semibold text-white transition-colors sm:py-2.5 sm:text-sm"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        @click.stop="onOpen"
      >
        {{ t("collection.open") }}
      </button>
    </div>
  </div>
</template>
