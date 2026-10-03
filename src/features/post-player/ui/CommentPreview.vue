<script setup lang="ts">
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";
import { parseTextLinks, truncateLinkSegments } from "@/shared/lib/linkify";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import { useCommentPreview } from "../model/use-comment-preview";

/** Comment a shared Bastyon link points to (`…&commentid=`), shown inside the
 *  post card — like Bastyon's papi.comment: the comment and the one it answers. */
interface Props {
  commentId: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ open: [] }>();
const { t } = useI18n();

const { comment, replyTo, authors, loading, notFound, load } = useCommentPreview(props.commentId);

const COMMENT_PREVIEW_LENGTH = 300;
const REPLY_PREVIEW_LENGTH = 120;

const segments = computed(() =>
  truncateLinkSegments(parseTextLinks(comment.value?.message ?? ""), COMMENT_PREVIEW_LENGTH),
);
const replySegments = computed(() =>
  truncateLinkSegments(parseTextLinks(replyTo.value?.message ?? ""), REPLY_PREVIEW_LENGTH),
);

const author = computed(() => (comment.value ? authors.value[comment.value.address] : undefined));
const authorName = computed(() => author.value?.name || comment.value?.address.slice(0, 10) || "");
const replyAuthorName = computed(() =>
  replyTo.value ? authors.value[replyTo.value.address]?.name || replyTo.value.address.slice(0, 10) : "",
);

const avatarError = ref(false);
const avatarUrl = computed(() => normalizePocketnetImageUrl(author.value?.image ?? ""));
const firstImage = computed(() => {
  const img = comment.value?.images?.[0];
  return img ? normalizePocketnetImageUrl(img) : "";
});

const commentDate = computed(() => {
  if (!comment.value?.time) return "";
  return new Date(comment.value.time * 1000).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
});

function onLinkClick(href: string) {
  void openExternalUrl(href);
}

onMounted(load);
</script>

<template>
  <div
    class="mt-1 rounded-xl border p-2.5"
    :class="isOwn ? 'border-white/10 bg-white/5' : 'border-neutral-grad-1/50 bg-neutral-grad-0/30'"
    data-testid="comment-preview"
  >
    <!-- Loading -->
    <div v-if="loading" class="flex gap-2">
      <div class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="h-3 w-24 animate-pulse rounded bg-neutral-grad-2" />
        <div class="h-3 w-full animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>

    <div
      v-else-if="notFound || !comment"
      class="text-xs"
      :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
    >{{ t("post.commentNotFound") }}</div>

    <div v-else class="cursor-pointer" @click.stop="emit('open')">
      <!-- The comment it answers -->
      <div
        v-if="replyTo"
        class="mb-2 border-l-2 pl-2 text-xs"
        :class="isOwn ? 'border-white/30 text-white/60' : 'border-color-bg-ac/50 text-text-on-main-bg-color'"
        data-testid="comment-preview-reply"
      >
        <div class="font-semibold">{{ t("post.inReplyTo", { name: replyAuthorName }) }}</div>
        <div class="line-clamp-2 break-words"><template v-for="(seg, i) in replySegments" :key="i">{{ seg.content }}</template></div>
      </div>

      <div class="flex gap-2">
        <img
          v-if="avatarUrl && !avatarError"
          :src="avatarUrl"
          alt=""
          class="h-7 w-7 shrink-0 rounded-full object-cover"
          @error="avatarError = true"
        />
        <div
          v-else
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
          :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
        >{{ authorName.charAt(0).toUpperCase() }}</div>

        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate text-xs font-semibold" :class="isOwn ? 'text-white' : 'text-text-color'">{{ authorName }}</span>
            <span v-if="commentDate" class="shrink-0 text-[10px]" :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">{{ commentDate }}</span>
          </div>

          <div
            v-if="comment.deleted"
            class="text-xs italic"
            :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
          >{{ t("post.commentDeleted") }}</div>
          <div
            v-else-if="segments.length"
            class="select-text whitespace-pre-wrap break-words text-xs leading-relaxed sm:text-[13px]"
            :class="isOwn ? 'text-white/90' : 'text-text-color'"
          ><template v-for="(seg, i) in segments" :key="i"><a
            v-if="seg.type === 'link'"
            :href="seg.href"
            target="_blank"
            rel="noopener noreferrer"
            class="break-all underline hover:no-underline"
            :class="isOwn ? 'text-white' : 'text-color-txt-ac'"
            @click.stop.prevent="onLinkClick(seg.href)"
          >{{ seg.content }}</a><template v-else>{{ seg.content }}</template></template></div>

          <img
            v-if="firstImage && !comment.deleted"
            :src="firstImage"
            alt=""
            class="mt-1 max-h-40 max-w-full rounded-lg object-cover"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  </div>
</template>
