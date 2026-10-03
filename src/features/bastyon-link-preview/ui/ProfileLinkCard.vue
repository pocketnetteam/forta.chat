<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import { withTimeout } from "@/shared/lib/with-timeout";
import { resolveProfileAddress } from "../model/resolve-profile-address";

// Same bound as PostCard / CollectionCard: on slow networks (Tor) the load can
// hang, after this the skeleton falls back to the plain link.
const PROFILE_LOAD_TIMEOUT_MS = 15_000;

interface Props {
  /** https://bastyon.com/… form of the link — opened when there is no profile. */
  href: string;
  name?: string;
  address?: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();

// Open user profile in-app (provided by ChatWindow)
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

const loading = ref(true);
const resolvedAddress = ref<string | null>(null);
const displayName = ref("");
const about = ref("");
const image = ref("");
const subscribers = ref<number | null>(null);
const avatarError = ref(false);

const avatarUrl = computed(() => normalizePocketnetImageUrl(image.value));

async function loadProfile() {
  loading.value = true;
  try {
    // Bounded inside the resolver, so a hung lookup is not cached either.
    const address = await resolveProfileAddress(
      { name: props.name, address: props.address },
      (n) => authStore.checkUsername(n),
    );
    if (!address) return;
    await withTimeout(authStore.loadUsersInfo([address]), PROFILE_LOAD_TIMEOUT_MS, "loadUsersInfo");
    const user = authStore.getBastyonUserData(address);
    if (!user?.name) return;
    resolvedAddress.value = address;
    displayName.value = user.name;
    about.value = user.about || "";
    image.value = user.image || "";
    subscribers.value = typeof user.subscribers_count === "number" ? user.subscribers_count : null;
  } catch (e) {
    console.warn("[ProfileLinkCard] profile load failed:", e);
  } finally {
    loading.value = false;
  }
}

function onOpen() {
  if (resolvedAddress.value && openUserProfile) {
    openUserProfile(resolvedAddress.value);
    return;
  }
  void openExternalUrl(props.href);
}

onMounted(loadProfile);
</script>

<template>
  <!-- Loading skeleton — matches loaded card dimensions to prevent layout shift -->
  <div
    v-if="loading"
    class="my-1.5 w-[20rem] max-w-full overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/10' : 'border-neutral-grad-1/50 bg-background-total-theme'"
  >
    <div class="flex items-center gap-3 p-3 sm:p-4">
      <div class="h-14 w-14 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="h-3 w-16 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-4 w-3/4 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-3 w-1/2 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>
  </div>

  <!-- Unknown user / load failed: the link stays a plain link -->
  <a
    v-else-if="!resolvedAddress"
    :href="href"
    rel="noopener noreferrer"
    class="break-all text-color-txt-ac underline hover:no-underline"
    @click.stop.prevent="onOpen"
  >{{ href }}</a>

  <!-- Profile card -->
  <div
    v-else
    class="my-1.5 w-[20rem] max-w-full cursor-pointer overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
    @click.stop="onOpen"
  >
    <div class="flex items-center gap-3 p-3 sm:p-4">
      <img
        v-if="avatarUrl && !avatarError"
        :src="avatarUrl"
        alt=""
        class="h-14 w-14 shrink-0 rounded-full object-cover"
        loading="lazy"
        @error="avatarError = true"
      />
      <div
        v-else
        class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-bold"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >{{ displayName.charAt(0).toUpperCase() }}</div>

      <div class="flex min-w-0 flex-col gap-0.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-wider"
          :class="isOwn ? 'text-white/60' : 'text-color-txt-ac'"
        >{{ t("profileLink.label") }}</span>
        <span
          class="truncate text-sm font-semibold leading-snug sm:text-base"
          :class="isOwn ? 'text-white' : 'text-text-color'"
        >{{ displayName }}</span>
        <span
          v-if="subscribers !== null"
          class="text-[11px] sm:text-xs"
          :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'"
        >{{ t("profileLink.subscribers", { count: subscribers }) }}</span>
      </div>
    </div>

    <div
      v-if="about"
      class="line-clamp-3 whitespace-pre-wrap break-words px-3 text-xs leading-relaxed sm:px-4 sm:text-[13px]"
      :class="isOwn ? 'text-white/80' : 'text-text-color/80'"
    >{{ about }}</div>

    <div class="p-3 sm:p-4">
      <button
        class="w-full rounded-xl py-2 text-xs font-semibold text-white transition-colors sm:py-2.5 sm:text-sm"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        @click.stop="onOpen"
      >
        {{ t("profileLink.open") }}
      </button>
    </div>
  </div>
</template>
