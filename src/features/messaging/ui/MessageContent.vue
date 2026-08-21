<script setup lang="ts">
import { computed, inject, type Ref, ref } from "vue";
import { Capacitor } from "@capacitor/core";
import { parseMessage, applyLocalAlias } from "@/shared/lib/message-format";
import type { Segment } from "@/shared/lib/message-format";
import { PostCard } from "@/features/post-player";
import { splitByQuery, type TextPart } from "@/shared/lib/utils/highlight";
import type { LinkPreview } from "@/entities/chat";
import { useChatStore } from "@/entities/chat";
import LinkPreviewCard from "./LinkPreviewCard.vue";

interface Props {
  text: string;
  isOwn?: boolean;
  linkPreview?: LinkPreview | null;
}

const props = withDefaults(defineProps<Props>(), { isOwn: false });
const emit = defineEmits<{ mentionClick: [userId: string] }>();

const searchQuery = inject<Ref<string>>("searchQuery", ref(""));
const chatStore = useChatStore();

// Map each mention to the viewer's local alias (if any) so a renamed
// contact reads `@qqq` here even when the sender shipped `@dqwewr`. The
// userId carried by the segment is untouched, so click-through still
// opens the correct profile. (WEE-39 follow-up.)
const segments = computed<Segment[]>(() =>
  parseMessage(props.text).map((s) =>
    applyLocalAlias(s, (userId) => chatStore.getLocalAlias(userId)),
  ),
);
const activeQuery = computed(() => searchQuery.value?.trim() ?? "");

/** Inline segments (text, link, mention) vs block segments (bastyonLink) */
const hasBlockSegments = computed(() => segments.value.some(s => s.type === "bastyonLink"));

// Capacitor Android WebView treats `<a target="_blank">` as a no-op (there is
// no concept of a new tab), so a plain anchor leaves the user stuck. Intercept
// the click and route through @capacitor/browser on native, fall back to
// window.open everywhere else. (WEE-42, forta-bugs#815/#351.)
function openExternalLink(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}

async function handleLinkClick(event: MouseEvent, href: string): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (!Capacitor.isNativePlatform()) {
    openExternalLink(href);
    return;
  }
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: href });
  } catch (err) {
    // Plugin missing or rejected — at least give the user *something*. On
    // Capacitor Android `window.open` may still no-op, but it does no harm.
    console.error("[MessageContent] Browser.open failed, falling back:", err);
    openExternalLink(href);
  }
}
</script>

<template>
  <!-- When there are block-level embeds, use div wrapper to avoid div-in-span -->
  <div v-if="hasBlockSegments" class="select-text">
    <template v-for="(seg, i) in segments" :key="i">
      <template v-if="seg.type === 'text'">
        <template v-if="activeQuery">
          <template v-for="(part, j) in splitByQuery(seg.content, activeQuery)" :key="j">
            <mark v-if="part.highlight" class="rounded-sm bg-yellow-300/50 text-current">{{ part.text }}</mark>
            <span v-else class="whitespace-pre-wrap break-words">{{ part.text }}</span>
          </template>
        </template>
        <span v-else class="whitespace-pre-wrap break-words">{{ seg.content }}</span>
      </template>
      <a
        v-else-if="seg.type === 'link'"
        :href="seg.href"
        rel="noopener noreferrer"
        class="text-color-txt-ac underline hover:no-underline"
        @click="handleLinkClick($event, seg.href)"
      >{{ seg.content }}</a>
      <span
        v-else-if="seg.type === 'mention'"
        class="cursor-pointer font-medium text-color-txt-ac"
        @click.stop="emit('mentionClick', seg.userId)"
      >{{ seg.content }}</span>
      <PostCard
        v-else-if="seg.type === 'bastyonLink'"
        :txid="seg.txid"
        :is-own="props.isOwn"
        :initial-comment-id="seg.commentId"
      />
    </template>
    <LinkPreviewCard v-if="props.linkPreview" :preview="props.linkPreview" :is-own="props.isOwn" />
  </div>

  <!-- Default: pure inline content (no block embeds) -->
  <div v-else class="select-text">
    <span class="whitespace-pre-wrap break-words">
      <template v-for="(seg, i) in segments" :key="i">
        <template v-if="seg.type === 'text'">
          <template v-if="activeQuery">
            <template v-for="(part, j) in splitByQuery(seg.content, activeQuery)" :key="j">
              <mark v-if="part.highlight" class="rounded-sm bg-yellow-300/50 text-current">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </template>
          <span v-else>{{ seg.content }}</span>
        </template>
        <a
          v-else-if="seg.type === 'link'"
          :href="seg.href"
          rel="noopener noreferrer"
          class="text-color-txt-ac underline hover:no-underline"
          @click="handleLinkClick($event, seg.href)"
        >{{ seg.content }}</a>
        <span
          v-else-if="seg.type === 'mention'"
          class="cursor-pointer font-medium text-color-txt-ac"
          @click.stop="emit('mentionClick', seg.userId)"
        >{{ seg.content }}</span>
      </template>
    </span>
    <LinkPreviewCard v-if="props.linkPreview" :preview="props.linkPreview" :is-own="props.isOwn" />
  </div>
</template>
