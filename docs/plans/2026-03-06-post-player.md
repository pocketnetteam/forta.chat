# Post Player Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Full-featured post player with inline video, star ratings, comments, boost/donate, and sharing — all integrated with Pocketnet SDK.

**Architecture:** Hybrid approach — Vue 3 Composition API for UI, Pocketnet SDK globals (`Api`, `Actions`, `pSDK`) for blockchain operations. New feature module `src/features/post-player/` with composables and components. Replaces existing `PostEmbed.vue`.

**Tech Stack:** Vue 3, TypeScript, Tailwind CSS, Pocketnet SDK (global `Api.rpc`, `Actions.addActionAndSendIfCan`), existing `AppInitializer` for post loading.

---

### Task 1: Extend BastyonPostData and AppInitializer with scores/comments API

**Files:**
- Modify: `src/app/providers/initializers/app-initializer.ts:6-16` (interface) and add new methods
- Modify: `src/entities/auth/model/stores.ts` (expose new methods)

**Step 1: Extend BastyonPostData interface**

Add score fields to `src/app/providers/initializers/app-initializer.ts:6-16`:

```typescript
export interface BastyonPostData {
  txid: string;
  address: string;
  caption: string;
  message: string;
  images: string[];
  url: string;
  tags: string[];
  settings: { v?: string };
  time: number;
  // New fields for post player
  scoreSum?: number;
  scoreCnt?: number;
  myVal?: number;
}

export interface PostScore {
  address: string;
  value: number;
  posttxid: string;
}

export interface PostComment {
  id: string;
  postid: string;
  parentid: string;
  answerid: string;
  address: string;
  message: string;
  time: number;
  scoreUp: number;
  scoreDown: number;
  myScore?: number;
  children?: PostComment[];
}
```

**Step 2: Add loadPostScores method to AppInitializer**

Add after `loadPost` method (~line 307):

```typescript
async loadPostScores(txid: string): Promise<PostScore[]> {
  if (!this.api) return [];
  try {
    const data = await this.api.rpc("getpostscores", [txid]);
    if (!Array.isArray(data)) return [];
    return data.map((s: any) => ({
      address: s.address ?? "",
      value: Number(s.value ?? 0),
      posttxid: s.posttxid ?? txid,
    }));
  } catch (e) {
    console.error("[appInit] loadPostScores error:", e);
    return [];
  }
}

async loadPostComments(txid: string, offset = 0, limit = 20): Promise<PostComment[]> {
  if (!this.api) return [];
  try {
    const data = await this.api.rpc("getcomments", ["", "", "", [txid]]);
    if (!Array.isArray(data)) return [];
    return data.map((c: any) => ({
      id: c.id ?? "",
      postid: c.postid ?? txid,
      parentid: c.parentid ?? "",
      answerid: c.answerid ?? "",
      address: c.address ?? "",
      message: decodeURIComponent(c.msg ?? c.message ?? ""),
      time: Number(c.time ?? 0),
      scoreUp: Number(c.scoreUp ?? 0),
      scoreDown: Number(c.scoreDown ?? 0),
      myScore: c.myScore ? Number(c.myScore) : undefined,
    }));
  } catch (e) {
    console.error("[appInit] loadPostComments error:", e);
    return [];
  }
}

async loadMyPostScore(txid: string, address: string): Promise<number | null> {
  if (!this.api) return null;
  try {
    const data = await this.api.rpc("getposcores", [[txid], address]);
    if (Array.isArray(data) && data.length > 0) {
      return Number(data[0]?.value ?? 0);
    }
    return null;
  } catch {
    return null;
  }
}

/** Submit an upvote for a post (1-5 stars) via SDK */
async submitUpvote(txid: string, value: number, address: string): Promise<boolean> {
  if (!this.actions || !this.psdk) return false;
  try {
    // Load the share object
    await new Promise<void>((resolve) => {
      this.psdk!.node.shares.getbyid([txid], () => resolve());
    });
    const share = this.psdk.share.get(txid);
    if (!share) return false;

    const upvoteShare = share.upvote(value);
    if (!upvoteShare) return false;

    await this.actions.addActionAndSendIfCan(upvoteShare);
    return true;
  } catch (e) {
    console.error("[appInit] submitUpvote error:", e);
    return false;
  }
}

/** Submit a comment on a post via SDK */
async submitComment(txid: string, message: string, parentId?: string): Promise<boolean> {
  if (!this.actions) return false;
  try {
    const comment = new Comment(txid);
    comment.message.set(message);
    if (parentId) comment.parentid = parentId;
    await this.actions.addActionAndSendIfCan(comment);
    return true;
  } catch (e) {
    console.error("[appInit] submitComment error:", e);
    return false;
  }
}

get available() { return this._available; }
get apiInstance() { return this.api; }
get actionsInstance() { return this.actions; }
get psdkInstance() { return this.psdk; }
```

**Step 3: Expose new methods in auth store**

Add to `src/entities/auth/model/stores.ts` next to existing `loadPost`:

```typescript
const loadPostScores = (txid: string) => appInitializer.loadPostScores(txid);
const loadPostComments = (txid: string) => appInitializer.loadPostComments(txid);
const loadMyPostScore = (txid: string) => appInitializer.loadMyPostScore(txid, address.value!);
const submitUpvote = (txid: string, value: number) => appInitializer.submitUpvote(txid, value, address.value!);
const submitComment = (txid: string, message: string, parentId?: string) => appInitializer.submitComment(txid, message, parentId);
```

And add them to the store's return object.

**Step 4: Commit**

```bash
git add src/app/providers/initializers/app-initializer.ts src/entities/auth/model/stores.ts
git commit -m "feat(post-player): extend AppInitializer with scores, comments, upvote APIs"
```

---

### Task 2: Create composables for post player

**Files:**
- Create: `src/features/post-player/model/use-post-scores.ts`
- Create: `src/features/post-player/model/use-post-comments.ts`
- Create: `src/features/post-player/model/use-post-boost.ts`

**Step 1: Create use-post-scores.ts**

```typescript
import { ref, computed } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { PostScore } from "@/app/providers/initializers";

export function usePostScores(txid: string) {
  const authStore = useAuthStore();
  const scores = ref<PostScore[]>([]);
  const myScore = ref<number | null>(null);
  const loading = ref(false);
  const submitting = ref(false);

  const averageScore = computed(() => {
    if (scores.value.length === 0) return 0;
    const sum = scores.value.reduce((acc, s) => acc + s.value, 0);
    return sum / scores.value.length;
  });

  const totalVotes = computed(() => scores.value.length);
  const hasVoted = computed(() => myScore.value !== null && myScore.value > 0);

  const load = async () => {
    loading.value = true;
    try {
      const [scoresData, myVal] = await Promise.all([
        authStore.loadPostScores(txid),
        authStore.loadMyPostScore(txid),
      ]);
      scores.value = scoresData;
      myScore.value = myVal;
    } finally {
      loading.value = false;
    }
  };

  const submitVote = async (value: number) => {
    if (hasVoted.value || submitting.value) return false;
    submitting.value = true;
    try {
      const ok = await authStore.submitUpvote(txid, value);
      if (ok) {
        myScore.value = value;
        scores.value = [...scores.value, {
          address: authStore.address!,
          value,
          posttxid: txid,
        }];
      }
      return ok;
    } finally {
      submitting.value = false;
    }
  };

  return { scores, myScore, averageScore, totalVotes, hasVoted, loading, submitting, load, submitVote };
}
```

**Step 2: Create use-post-comments.ts**

```typescript
import { ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { PostComment } from "@/app/providers/initializers";

export function usePostComments(txid: string) {
  const authStore = useAuthStore();
  const comments = ref<PostComment[]>([]);
  const loading = ref(false);
  const submitting = ref(false);
  const hasMore = ref(true);

  const load = async () => {
    loading.value = true;
    try {
      const data = await authStore.loadPostComments(txid);
      comments.value = data;
      hasMore.value = false; // API returns all comments for the post
    } finally {
      loading.value = false;
    }
  };

  const submit = async (message: string, parentId?: string) => {
    if (!message.trim() || submitting.value) return false;
    submitting.value = true;
    try {
      const ok = await authStore.submitComment(txid, message, parentId);
      if (ok) {
        // Reload comments to get the server-confirmed version
        await load();
      }
      return ok;
    } finally {
      submitting.value = false;
    }
  };

  return { comments, loading, submitting, hasMore, load, submit };
}
```

**Step 3: Create use-post-boost.ts**

```typescript
import { ref } from "vue";

export function usePostBoost() {
  const showDonateModal = ref(false);
  const boostAddress = ref("");

  const openBoost = (authorAddress: string) => {
    boostAddress.value = authorAddress;
    showDonateModal.value = true;
  };

  const closeBoost = () => {
    showDonateModal.value = false;
    boostAddress.value = "";
  };

  return { showDonateModal, boostAddress, openBoost, closeBoost };
}
```

**Step 4: Commit**

```bash
git add src/features/post-player/model/
git commit -m "feat(post-player): add composables for scores, comments, boost"
```

---

### Task 3: Create StarRating component

**Files:**
- Create: `src/features/post-player/ui/StarRating.vue`

**Step 1: Implement StarRating**

```vue
<script setup lang="ts">
interface Props {
  modelValue?: number | null; // current user's rating
  average?: number;           // average rating to display
  totalVotes?: number;
  readonly?: boolean;
  compact?: boolean;          // compact mode for inline card
  submitting?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: null,
  average: 0,
  totalVotes: 0,
  readonly: false,
  compact: false,
  submitting: false,
});

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const hoverValue = ref(0);

const displayValue = computed(() => {
  if (hoverValue.value > 0) return hoverValue.value;
  if (props.modelValue) return props.modelValue;
  return props.average;
});

const isInteractive = computed(() => !props.readonly && !props.modelValue && !props.submitting);

const onHover = (star: number) => {
  if (isInteractive.value) hoverValue.value = star;
};

const onLeave = () => {
  hoverValue.value = 0;
};

const onClick = (star: number) => {
  if (isInteractive.value) emit("update:modelValue", star);
};
</script>

<template>
  <div class="inline-flex items-center gap-1">
    <div
      class="flex"
      :class="{ 'cursor-pointer': isInteractive, 'gap-0.5': !compact, 'gap-px': compact }"
      @mouseleave="onLeave"
    >
      <svg
        v-for="star in 5"
        :key="star"
        :width="compact ? 12 : 20"
        :height="compact ? 12 : 20"
        viewBox="0 0 24 24"
        class="transition-colors"
        :class="[
          star <= displayValue
            ? 'fill-yellow-400 text-yellow-400'
            : 'fill-none text-gray-400',
          isInteractive ? 'hover:scale-110' : '',
          submitting ? 'animate-pulse' : '',
        ]"
        stroke="currentColor"
        stroke-width="1.5"
        @mouseenter="onHover(star)"
        @click="onClick(star)"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </div>
    <span v-if="!compact && totalVotes > 0" class="text-xs text-gray-400">
      {{ average.toFixed(1) }} · {{ totalVotes }}
    </span>
    <span v-if="compact && totalVotes > 0" class="text-[10px] text-gray-400">
      {{ average.toFixed(1) }}
    </span>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/post-player/ui/StarRating.vue
git commit -m "feat(post-player): add StarRating component"
```

---

### Task 4: Create VideoPlayer component

**Files:**
- Create: `src/features/post-player/ui/VideoPlayer.vue`

**Step 1: Implement VideoPlayer**

```vue
<script setup lang="ts">
import { parseVideoUrl } from "@/shared/lib/video-embed";

interface Props {
  url: string;
  inline?: boolean; // true = smaller for card view
}

const props = withDefaults(defineProps<Props>(), { inline: false });

const videoInfo = computed(() => parseVideoUrl(props.url));
const playing = ref(false);
const error = ref(false);

const thumbUrl = computed(() => videoInfo.value?.thumbUrl || "");

const play = () => {
  playing.value = true;
};

const onIframeError = () => {
  error.value = true;
  playing.value = false;
};
</script>

<template>
  <div
    v-if="videoInfo"
    class="relative overflow-hidden rounded-lg bg-black"
    :class="inline ? 'aspect-video max-h-48' : 'aspect-video w-full'"
  >
    <!-- Iframe player (after click) -->
    <iframe
      v-if="playing && !error"
      :src="videoInfo.embedUrl + '?autoplay=1'"
      class="absolute inset-0 h-full w-full"
      frameborder="0"
      allow="autoplay; fullscreen; picture-in-picture"
      allowfullscreen
      @error="onIframeError"
    />

    <!-- Thumbnail + play button (before click) -->
    <template v-else>
      <img
        v-if="thumbUrl"
        :src="thumbUrl"
        alt=""
        class="h-full w-full object-cover"
        loading="lazy"
      />
      <div v-else class="flex h-full w-full items-center justify-center bg-gray-900">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1" opacity="0.3">
          <rect x="2" y="2" width="20" height="20" rx="2" />
          <path d="M10 8l6 4-6 4V8z" fill="white" opacity="0.3" />
        </svg>
      </div>

      <button
        class="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20"
        @click.stop="play"
      >
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#000">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    </template>

    <!-- Error fallback -->
    <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-gray-900">
      <a
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-blue-400 underline"
        @click.stop
      >Open video externally</a>
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/post-player/ui/VideoPlayer.vue
git commit -m "feat(post-player): add VideoPlayer iframe component"
```

---

### Task 5: Create PostAuthor and PostActions components

**Files:**
- Create: `src/features/post-player/ui/PostAuthor.vue`
- Create: `src/features/post-player/ui/PostActions.vue`

**Step 1: Implement PostAuthor**

```vue
<script setup lang="ts">
interface Props {
  name: string;
  avatarUrl: string;
  address: string;
  time?: number;
}

const props = defineProps<Props>();

const formattedTime = computed(() => {
  if (!props.time) return "";
  return new Date(props.time * 1000).toLocaleDateString();
});
</script>

<template>
  <div class="flex items-center gap-2.5">
    <img
      v-if="avatarUrl"
      :src="avatarUrl"
      alt=""
      class="h-8 w-8 rounded-full object-cover"
    />
    <div
      v-else
      class="flex h-8 w-8 items-center justify-center rounded-full bg-color-bg-ac/20 text-sm font-bold text-color-bg-ac"
    >
      {{ name.charAt(0).toUpperCase() }}
    </div>
    <div class="flex flex-col">
      <span class="text-sm font-medium text-text-color">{{ name }}</span>
      <span v-if="formattedTime" class="text-xs text-gray-400">{{ formattedTime }}</span>
    </div>
  </div>
</template>
```

**Step 2: Implement PostActions**

```vue
<script setup lang="ts">
interface Props {
  totalComments: number;
  isOwnPost: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
  boost: [];
  share: [];
  scrollToComments: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex items-center gap-3 border-t border-gray-200/10 pt-3">
    <button
      v-if="!isOwnPost"
      class="flex items-center gap-1.5 rounded-lg bg-color-bg-ac/10 px-3 py-1.5 text-xs font-medium text-color-bg-ac transition-colors hover:bg-color-bg-ac/20"
      @click="emit('boost')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
      {{ t("postPlayer.boost") }}
    </button>

    <button
      class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-500/10 hover:text-gray-300"
      @click="emit('scrollToComments')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {{ totalComments }}
    </button>

    <button
      class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-500/10 hover:text-gray-300"
      @click="emit('share')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
      </svg>
      {{ t("postPlayer.share") }}
    </button>
  </div>
</template>
```

**Step 3: Commit**

```bash
git add src/features/post-player/ui/PostAuthor.vue src/features/post-player/ui/PostActions.vue
git commit -m "feat(post-player): add PostAuthor and PostActions components"
```

---

### Task 6: Create PostComments component

**Files:**
- Create: `src/features/post-player/ui/PostComments.vue`

**Step 1: Implement PostComments**

```vue
<script setup lang="ts">
import type { PostComment } from "@/app/providers/initializers";
import { useAuthStore } from "@/entities/auth";

interface Props {
  comments: PostComment[];
  loading: boolean;
  submitting: boolean;
}

defineProps<Props>();
const emit = defineEmits<{ submit: [message: string] }>();
const { t } = useI18n();

const authStore = useAuthStore();
const newComment = ref("");

const authorNames = ref<Record<string, string>>({});
const authorAvatars = ref<Record<string, string>>({});

const resolveAuthors = async (comments: PostComment[]) => {
  const addresses = [...new Set(comments.map((c) => c.address))];
  await authStore.loadUsersInfo(addresses);
  for (const addr of addresses) {
    const user = authStore.getBastyonUserData(addr);
    if (user) {
      authorNames.value[addr] = user.name || addr.slice(0, 10);
      authorAvatars.value[addr] = user.image
        ? (user.image.startsWith("http") ? user.image : `https://bastyon.com/images/${user.image}`)
        : "";
    } else {
      authorNames.value[addr] = addr.slice(0, 10);
    }
  }
};

watch(() => props.comments, (val) => {
  if (val.length) resolveAuthors(val);
}, { immediate: true });

const handleSubmit = () => {
  const msg = newComment.value.trim();
  if (!msg) return;
  emit("submit", msg);
  newComment.value = "";
};

const formatTime = (ts: number) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <h3 class="text-sm font-semibold text-text-color">
      {{ t("postPlayer.comments") }} ({{ comments.length }})
    </h3>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center gap-2 py-4">
      <div class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
      <span class="text-xs text-gray-400">{{ t("post.loading") }}</span>
    </div>

    <!-- Empty -->
    <div v-else-if="comments.length === 0" class="py-4 text-center text-xs text-gray-400">
      {{ t("postPlayer.noComments") }}
    </div>

    <!-- Comment list -->
    <div v-else class="flex max-h-64 flex-col gap-2.5 overflow-y-auto">
      <div
        v-for="comment in comments"
        :key="comment.id"
        class="flex gap-2 rounded-lg bg-white/5 p-2.5"
      >
        <img
          v-if="authorAvatars[comment.address]"
          :src="authorAvatars[comment.address]"
          alt=""
          class="h-6 w-6 flex-shrink-0 rounded-full object-cover"
        />
        <div
          v-else
          class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-color-bg-ac/20 text-[10px] font-bold text-color-bg-ac"
        >
          {{ (authorNames[comment.address] || "?").charAt(0).toUpperCase() }}
        </div>
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-text-color">
              {{ authorNames[comment.address] || comment.address.slice(0, 10) }}
            </span>
            <span class="text-[10px] text-gray-500">{{ formatTime(comment.time) }}</span>
          </div>
          <p class="text-xs leading-relaxed text-text-color/80">{{ comment.message }}</p>
        </div>
      </div>
    </div>

    <!-- Comment input -->
    <div class="flex gap-2">
      <input
        v-model="newComment"
        type="text"
        :placeholder="t('postPlayer.writeComment')"
        class="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-text-color placeholder-gray-500 outline-none focus:border-color-bg-ac/40"
        :disabled="submitting"
        @keydown.enter="handleSubmit"
      />
      <button
        class="rounded-lg bg-color-bg-ac px-3 py-2 text-xs font-medium text-white transition-opacity disabled:opacity-40"
        :disabled="!newComment.trim() || submitting"
        @click="handleSubmit"
      >
        {{ t("postPlayer.send") }}
      </button>
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/post-player/ui/PostComments.vue
git commit -m "feat(post-player): add PostComments component with input"
```

---

### Task 7: Create PostPlayerModal

**Files:**
- Create: `src/features/post-player/ui/PostPlayerModal.vue`

**Step 1: Implement PostPlayerModal**

```vue
<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";
import { usePostScores } from "../model/use-post-scores";
import { usePostComments } from "../model/use-post-comments";
import { usePostBoost } from "../model/use-post-boost";
import VideoPlayer from "./VideoPlayer.vue";
import StarRating from "./StarRating.vue";
import PostAuthor from "./PostAuthor.vue";
import PostActions from "./PostActions.vue";
import PostComments from "./PostComments.vue";
import { DonateModal } from "@/features/wallet";
import { parseVideoUrl } from "@/shared/lib/video-embed";

interface Props {
  post: BastyonPostData;
  authorName: string;
  authorAvatarUrl: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const authStore = useAuthStore();

const commentsRef = ref<HTMLElement | null>(null);

const {
  scores, myScore, averageScore, totalVotes, hasVoted, loading: scoresLoading, submitting: scoresSubmitting,
  load: loadScores, submitVote,
} = usePostScores(props.post.txid);

const {
  comments, loading: commentsLoading, submitting: commentsSubmitting,
  load: loadComments, submit: submitComment,
} = usePostComments(props.post.txid);

const { showDonateModal, boostAddress, openBoost, closeBoost } = usePostBoost();

const videoInfo = computed(() => props.post.url ? parseVideoUrl(props.post.url) : null);
const isOwnPost = computed(() => props.post.address === authStore.address);
const isArticle = computed(() => props.post.settings?.v === "a");

const images = computed(() => {
  return (props.post.images || []).map((img) =>
    img.startsWith("http") ? img : `https://bastyon.com/images/${img}`
  );
});

const handleRate = async (value: number) => {
  await submitVote(value);
};

const handleBoost = () => {
  openBoost(props.post.address);
};

const handleShare = () => {
  // Copy bastyon link to clipboard
  const link = `bastyon://post?s=${props.post.txid}`;
  navigator.clipboard.writeText(link);
};

const scrollToComments = () => {
  commentsRef.value?.scrollIntoView({ behavior: "smooth" });
};

const handleCommentSubmit = async (message: string) => {
  await submitComment(message);
};

// Close on Escape
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};

onMounted(() => {
  loadScores();
  loadComments();
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <!-- Backdrop -->
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="emit('close')"
    >
      <div
        class="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-color-main-bg shadow-2xl"
      >
        <!-- Close button -->
        <button
          class="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
          @click="emit('close')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <!-- Scrollable content -->
        <div class="flex-1 overflow-y-auto">
          <!-- Video -->
          <VideoPlayer v-if="videoInfo" :url="post.url" />

          <!-- Images -->
          <div v-else-if="images.length" class="max-h-72 overflow-hidden">
            <img
              :src="images[0]"
              alt=""
              class="w-full object-cover"
              loading="lazy"
            />
          </div>

          <div class="flex flex-col gap-4 p-4">
            <!-- Author -->
            <PostAuthor
              :name="authorName"
              :avatar-url="authorAvatarUrl"
              :address="post.address"
              :time="post.time"
            />

            <!-- Type badge -->
            <div v-if="isArticle || videoInfo" class="flex">
              <span class="rounded-full bg-color-bg-ac/15 px-2 py-0.5 text-[10px] font-medium text-color-bg-ac">
                {{ isArticle ? t("post.article") : t("post.video") }}
              </span>
            </div>

            <!-- Caption -->
            <h2 v-if="post.caption" class="text-base font-bold leading-snug text-text-color">
              {{ post.caption }}
            </h2>

            <!-- Full message -->
            <p v-if="post.message" class="whitespace-pre-wrap text-sm leading-relaxed text-text-color/80">
              {{ post.message }}
            </p>

            <!-- Tags -->
            <div v-if="post.tags.length" class="flex flex-wrap gap-1.5">
              <span
                v-for="tag in post.tags"
                :key="tag"
                class="rounded-full bg-color-bg-ac/10 px-2 py-0.5 text-[10px] text-color-bg-ac/70"
              >#{{ tag }}</span>
            </div>

            <!-- Star rating -->
            <div class="flex flex-col gap-2 border-t border-white/5 pt-3">
              <StarRating
                :model-value="myScore"
                :average="averageScore"
                :total-votes="totalVotes"
                :readonly="isOwnPost"
                :submitting="scoresSubmitting"
                @update:model-value="handleRate"
              />
              <span v-if="hasVoted" class="text-[10px] text-gray-400">
                {{ t("postPlayer.rated") }}
              </span>
            </div>

            <!-- Actions -->
            <PostActions
              :total-comments="comments.length"
              :is-own-post="isOwnPost"
              @boost="handleBoost"
              @share="handleShare"
              @scroll-to-comments="scrollToComments"
            />

            <!-- Comments -->
            <div ref="commentsRef" class="border-t border-white/5 pt-3">
              <PostComments
                :comments="comments"
                :loading="commentsLoading"
                :submitting="commentsSubmitting"
                @submit="handleCommentSubmit"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Donate modal -->
      <DonateModal
        v-if="showDonateModal"
        :receiver-address="boostAddress"
        :receiver-name="authorName"
        @close="closeBoost"
      />
    </div>
  </Teleport>
</template>
```

**Step 2: Commit**

```bash
git add src/features/post-player/ui/PostPlayerModal.vue
git commit -m "feat(post-player): add PostPlayerModal fullscreen viewer"
```

---

### Task 8: Create enhanced PostCard (replaces PostEmbed)

**Files:**
- Create: `src/features/post-player/ui/PostCard.vue`

**Step 1: Implement PostCard**

```vue
<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";
import { parseVideoUrl } from "@/shared/lib/video-embed";
import VideoPlayer from "./VideoPlayer.vue";
import StarRating from "./StarRating.vue";
import PostPlayerModal from "./PostPlayerModal.vue";
import { usePostScores } from "../model/use-post-scores";

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

// Lazy-load scores only for inline display
const scores = ref<{ average: number; total: number }>({ average: 0, total: 0 });

onMounted(async () => {
  try {
    const data = await authStore.loadPost(props.txid);
    if (!data) { error.value = true; return; }
    post.value = data;

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

    // Load scores in background
    authStore.loadPostScores(props.txid).then((s) => {
      if (s.length) {
        const sum = s.reduce((a, x) => a + x.value, 0);
        scores.value = { average: sum / s.length, total: s.length };
      }
    });
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!-- Loading -->
  <div
    v-if="loading"
    class="my-1 flex max-w-sm items-center gap-2 rounded-xl p-3"
    :class="isOwn ? 'bg-white/10' : 'bg-color-bg-ac/8'"
  >
    <div class="h-4 w-4 animate-pulse rounded-full" :class="isOwn ? 'bg-white/20' : 'bg-black/10'" />
    <span class="text-xs opacity-50">{{ t("post.loading") }}</span>
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
    class="my-1 max-w-sm cursor-pointer overflow-hidden rounded-xl"
    :class="isOwn ? 'bg-white/10' : 'bg-color-bg-ac/8'"
    @click="showModal = true"
  >
    <!-- Inline video player -->
    <VideoPlayer v-if="videoInfo" :url="post.url" inline />

    <!-- Image (if no video) -->
    <img
      v-else-if="firstImage"
      :src="firstImage"
      alt=""
      class="max-h-48 w-full object-cover"
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

      <!-- Message preview -->
      <div
        v-if="truncatedMessage"
        class="text-xs leading-relaxed"
        :class="isOwn ? 'text-white/70' : 'text-text-color/70'"
      >{{ truncatedMessage }}</div>

      <!-- Compact star rating + open hint -->
      <div class="flex items-center justify-between pt-1">
        <StarRating
          :average="scores.average"
          :total-votes="scores.total"
          compact
          readonly
        />
        <span class="text-[10px]" :class="isOwn ? 'text-white/40' : 'text-text-on-main-bg-color'">
          {{ t("post.openInBastyon") }}
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
```

**Step 2: Commit**

```bash
git add src/features/post-player/ui/PostCard.vue
git commit -m "feat(post-player): add PostCard with inline video and scores"
```

---

### Task 9: Create barrel export and wire into MessageContent

**Files:**
- Create: `src/features/post-player/index.ts`
- Modify: `src/features/messaging/ui/MessageContent.vue:5,76-80`

**Step 1: Create barrel export**

```typescript
export { default as PostCard } from "./ui/PostCard.vue";
export { default as PostPlayerModal } from "./ui/PostPlayerModal.vue";
```

**Step 2: Replace PostEmbed with PostCard in MessageContent.vue**

In `src/features/messaging/ui/MessageContent.vue`:

Change line 5:
```typescript
// OLD: import PostEmbed from "./PostEmbed.vue";
import { PostCard } from "@/features/post-player";
```

Change lines 76-80 (the `<PostEmbed>` usage):
```vue
<!-- OLD: <PostEmbed v-else-if="seg.type === 'bastyonLink'" :txid="seg.txid" :is-own="props.isOwn" /> -->
<PostCard
  v-else-if="seg.type === 'bastyonLink'"
  :txid="seg.txid"
  :is-own="props.isOwn"
/>
```

**Step 3: Commit**

```bash
git add src/features/post-player/index.ts src/features/messaging/ui/MessageContent.vue
git commit -m "feat(post-player): wire PostCard into MessageContent, replace PostEmbed"
```

---

### Task 10: Add i18n keys

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Add English keys**

Add after existing `post.*` keys:

```typescript
// Post player
"postPlayer.boost": "Boost",
"postPlayer.share": "Share",
"postPlayer.comments": "Comments",
"postPlayer.noComments": "No comments yet",
"postPlayer.writeComment": "Write a comment...",
"postPlayer.send": "Send",
"postPlayer.rated": "You rated this post",
"postPlayer.ratingRestricted": "Rating restricted",
"postPlayer.openPost": "Open full post",
```

**Step 2: Add Russian keys**

```typescript
// Post player
"postPlayer.boost": "Поддержать",
"postPlayer.share": "Поделиться",
"postPlayer.comments": "Комментарии",
"postPlayer.noComments": "Пока нет комментариев",
"postPlayer.writeComment": "Написать комментарий...",
"postPlayer.send": "Отправить",
"postPlayer.rated": "Вы оценили этот пост",
"postPlayer.ratingRestricted": "Оценка ограничена",
"postPlayer.openPost": "Открыть пост",
```

**Step 3: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat(post-player): add i18n keys for post player"
```

---

### Task 11: Verify and test

**Step 1: Run TypeScript check**

```bash
cd /Users/daniilkim/work/new-bastyon-chat && npx vue-tsc --noEmit
```

Expected: No errors

**Step 2: Run dev server**

```bash
npm run dev
```

Expected: App starts, send a message containing a bastyon post link, verify:
- PostCard renders with inline video player
- Star rating shows average
- Click opens PostPlayerModal
- Stars interactive (can rate)
- Comments load
- Can write comment
- Boost opens DonateModal
- Share copies link

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(post-player): complete post player with stars, comments, video, boost"
```
