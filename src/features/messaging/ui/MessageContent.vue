<script setup lang="ts">
import { inject, type Ref } from "vue";
import { parseMessage } from "@/shared/lib/message-format";
import type { Segment } from "@/shared/lib/message-format";
import { PostCard } from "@/features/post-player";

interface Props {
  text: string;
  isOwn?: boolean;
}

const props = withDefaults(defineProps<Props>(), { isOwn: false });
const emit = defineEmits<{ mentionClick: [userId: string] }>();

const searchQuery = inject<Ref<string>>("searchQuery", ref(""));

/** Split a text string into parts, wrapping search matches */
type TextPart = { text: string; highlight: boolean };

const splitByQuery = (text: string, query: string): TextPart[] => {
  if (!query) return [{ text, highlight: false }];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: TextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), highlight: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), highlight: false });
    }
    parts.push({ text: text.slice(idx, idx + query.length), highlight: true });
    cursor = idx + query.length;
  }

  return parts;
};

const segments = computed<Segment[]>(() => parseMessage(props.text));
const activeQuery = computed(() => searchQuery.value?.trim() ?? "");

/** Inline segments (text, link, mention) vs block segments (bastyonLink) */
const hasBlockSegments = computed(() => segments.value.some(s => s.type === "bastyonLink"));
</script>

<template>
  <!-- When there are block-level embeds, use div wrapper to avoid div-in-span -->
  <div v-if="hasBlockSegments">
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
        target="_blank"
        rel="noopener noreferrer"
        class="text-color-txt-ac underline hover:no-underline"
        @click.stop
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
      />
    </template>
  </div>

  <!-- Default: pure inline content (no block embeds) -->
  <span v-else class="whitespace-pre-wrap break-words">
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
        target="_blank"
        rel="noopener noreferrer"
        class="text-color-txt-ac underline hover:no-underline"
        @click.stop
      >{{ seg.content }}</a>
      <span
        v-else-if="seg.type === 'mention'"
        class="cursor-pointer font-medium text-color-txt-ac"
        @click.stop="emit('mentionClick', seg.userId)"
      >{{ seg.content }}</span>
    </template>
  </span>
</template>
