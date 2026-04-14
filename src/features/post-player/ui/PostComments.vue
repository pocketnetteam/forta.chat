<script setup lang="ts">
import type { PostComment } from "@/app/providers/initializers";
import { useAuthStore } from "@/entities/auth";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";

interface Props {
  comments: PostComment[];
  loading: boolean;
  submitting: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ submit: [message: string] }>();
const { t } = useI18n();
const authStore = useAuthStore();
const newComment = ref("");

const authorNames = ref<Record<string, string>>({});
const authorAvatars = ref<Record<string, string>>({});
const avatarErrors = ref<Record<string, boolean>>({});

function fixAvatarUrl(raw: string): string {
  return normalizePocketnetImageUrl(raw);
}

const resolveAuthors = async (comments: PostComment[]) => {
  const addresses = [...new Set(comments.map((c) => c.address))];
  if (!addresses.length) return;
  await authStore.loadUsersInfo(addresses);
  for (const addr of addresses) {
    const user = authStore.getBastyonUserData(addr);
    if (user) {
      authorNames.value[addr] = user.name || addr.slice(0, 10);
      authorAvatars.value[addr] = user.image ? fixAvatarUrl(user.image) : "";
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

    <div v-if="loading" class="flex items-center gap-2 py-4">
      <div class="h-4 w-4 shrink-0 contain-strict animate-spin rounded-full border-2 border-neutral-grad-2 border-t-transparent" />
      <span class="text-xs text-text-on-main-bg-color">{{ t("post.loading") }}</span>
    </div>

    <div v-else-if="comments.length === 0" class="py-4 text-center text-xs text-text-on-main-bg-color">
      {{ t("postPlayer.noComments") }}
    </div>

    <div v-else class="flex max-h-64 flex-col gap-2.5 overflow-y-auto">
      <div
        v-for="comment in comments"
        :id="`comment-${comment.id}`"
        :key="comment.id"
        class="flex gap-2 rounded-lg bg-neutral-grad-0/50 p-2.5 transition-colors"
        :class="{ 'opacity-50': comment.id.startsWith('temp-') }"
      >
        <img
          v-if="authorAvatars[comment.address] && !avatarErrors[comment.address]"
          :src="authorAvatars[comment.address]"
          alt=""
          class="h-6 w-6 flex-shrink-0 rounded-full object-cover"
          @error="avatarErrors[comment.address] = true"
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
            <span class="text-[10px] text-text-on-main-bg-color">{{ formatTime(comment.time) }}</span>
          </div>
          <p class="text-xs leading-relaxed text-text-color/80">{{ comment.message }}</p>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <input
        v-model="newComment"
        type="text"
        :placeholder="t('postPlayer.writeComment')"
        class="flex-1 rounded-lg border border-neutral-grad-0 bg-chat-input-bg px-3 py-2 text-xs text-text-color outline-none placeholder:text-neutral-grad-2 focus:border-color-bg-ac/40"
        :disabled="submitting"
        @keydown.enter="handleSubmit"
      />
      <button
        class="flex items-center gap-1.5 rounded-lg bg-color-bg-ac px-3 py-2 text-xs font-medium text-text-on-bg-ac-color transition-opacity disabled:opacity-40"
        :disabled="!newComment.trim() || submitting"
        @click="handleSubmit"
      >
        <div v-if="submitting" class="h-3 w-3 shrink-0 contain-strict animate-spin rounded-full border-2 border-white/30 border-t-white" />
        {{ submitting ? t("post.loading") : t("postPlayer.send") }}
      </button>
    </div>
  </div>
</template>
