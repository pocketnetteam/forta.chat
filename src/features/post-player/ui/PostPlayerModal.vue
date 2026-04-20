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
import DonateModal from "@/features/wallet/ui/DonateModal.vue";
import { useChatStore } from "@/entities/chat";
import { parseVideoUrl } from "@/shared/lib/video-embed";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";

interface Props {
  post: BastyonPostData;
  authorName: string;
  authorAvatarUrl: string;
  initialCommentId?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const authStore = useAuthStore();
const commentsRef = ref<HTMLElement | null>(null);

const {
  myScore, averageScore, totalVotes, hasVoted,
  submitting: scoresSubmitting,
  load: loadScores, submitVote,
} = usePostScores(props.post.txid);

const {
  comments, loading: commentsLoading, submitting: commentsSubmitting,
  load: loadComments, submit: submitComment,
} = usePostComments(props.post.txid);

const { showDonateModal, boostAddress, openBoost, closeBoost } = usePostBoost();

const chatStore = useChatStore();
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

const onAuthorClick = () => {
  if (props.post.address && openUserProfile) {
    openUserProfile(props.post.address);
  }
};

const videoInfo = computed(() => props.post.url ? parseVideoUrl(props.post.url) : null);
const isOwnPost = computed(() => props.post.address === authStore.address);
const isArticle = computed(() => props.post.settings?.v === "a");

const images = computed(() =>
  (props.post.images || []).map((img) => normalizePocketnetImageUrl(img))
);

const handleRate = async (value: number) => {
  await submitVote(value);
};

const handleBoost = () => {
  openBoost(props.post.address);
};

const handleShare = () => {
  chatStore.initPostForward(
    `bastyon://post?s=${props.post.txid}`,
    props.authorName || undefined,
  );
};

const scrollToComments = () => {
  commentsRef.value?.scrollIntoView({ behavior: "smooth" });
};

const handleCommentSubmit = async (message: string) => {
  await submitComment(message);
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};

// Scroll to target comment after comments load
if (props.initialCommentId) {
  watch(comments, (list) => {
    if (list.length > 0) {
      nextTick(() => {
        const el = document.getElementById(`comment-${props.initialCommentId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-color-bg-ac", "ring-offset-1");
          setTimeout(() => el.classList.remove("ring-2", "ring-color-bg-ac", "ring-offset-1"), 3000);
        }
      });
    }
  }, { once: true });
}

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
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div
        class="post-modal relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-neutral-grad-0 bg-background-total-theme shadow-2xl"
      >
        <!-- Close -->
        <button
          class="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
          @click="emit('close')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto">
          <VideoPlayer v-if="videoInfo" :url="post.url" />
          <div v-else-if="images.length" class="max-h-80 overflow-hidden">
            <img :src="images[0]" alt="" class="w-full object-cover" loading="lazy" />
          </div>

          <div class="flex flex-col gap-4 p-5 text-text-color">
            <div class="cursor-pointer" @click="onAuthorClick">
              <PostAuthor
                :name="authorName"
                :avatar-url="authorAvatarUrl"
                :address="post.address"
                :time="post.time"
              />
            </div>

            <div v-if="isArticle || videoInfo" class="flex">
              <span class="rounded-full bg-color-bg-ac/15 px-2 py-0.5 text-[10px] font-medium text-color-bg-ac">
                {{ isArticle ? t("post.article") : t("post.video") }}
              </span>
            </div>

            <h2 v-if="post.caption" class="text-base font-bold leading-snug text-text-color">
              {{ post.caption }}
            </h2>

            <p v-if="post.message" class="whitespace-pre-wrap text-sm leading-relaxed text-text-color/80">
              {{ post.message }}
            </p>

            <div v-if="post.tags.length" class="flex flex-wrap gap-1.5">
              <span
                v-for="tag in post.tags"
                :key="tag"
                class="rounded-full bg-color-bg-ac/10 px-2 py-0.5 text-[10px] text-color-bg-ac/70"
              >#{{ tag }}</span>
            </div>

            <!-- Stars -->
            <div class="flex flex-col gap-2 border-t border-neutral-grad-0 pt-3">
              <div class="flex items-center gap-3">
                <StarRating
                  :model-value="myScore"
                  :average="averageScore"
                  :total-votes="totalVotes"
                  :readonly="isOwnPost"
                  :submitting="scoresSubmitting"
                  @update:model-value="handleRate"
                />
                <div
                  v-if="totalVotes > 0"
                  class="flex items-center gap-1 rounded-full border border-neutral-grad-1 px-2.5 py-1 text-text-on-main-bg-color"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                  </svg>
                  <span class="text-xs font-medium">{{ totalVotes }}</span>
                </div>
              </div>
              <span v-if="hasVoted" class="text-[10px] text-text-on-main-bg-color">
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
            <div ref="commentsRef" class="border-t border-neutral-grad-0 pt-3">
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
        :show="showDonateModal"
        :receiver-address="boostAddress"
        :receiver-name="authorName"
        @close="closeBoost"
      />

    </div>
  </Teleport>
</template>

<style scoped>
.post-modal {
  animation: modal-in 0.2s ease-out;
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@media (max-width: 640px) {
  .post-modal {
    max-height: 100vh;
    max-height: 100dvh;
    height: 100%;
    max-width: 100%;
    border-radius: 0;
  }
}
</style>
