<script setup lang="ts">
import type { CallLinkInfo } from "@/entities/chat/model/types";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import CallLinkIcon from "@/features/video-calls/ui/CallLinkIcon.vue";

interface Props {
  info: CallLinkInfo;
  isOwn?: boolean;
}

const props = withDefaults(defineProps<Props>(), { isOwn: false });
const { t } = useI18n();

function join(): void {
  void openExternalUrl(props.info.url);
}
</script>

<template>
  <div class="flex items-center gap-3" data-test="call-link-card">
    <CallLinkIcon size-class="h-10 w-10" :on-accent="props.isOwn" />
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-semibold">{{ props.info.label }}</div>
      <div class="truncate text-xs opacity-70">{{ t("call.linkSubtitle") }}</div>
    </div>
    <button
      type="button"
      data-test="call-link-join"
      class="btn-press shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium"
      :class="props.isOwn ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-color-bg-ac text-text-on-bg-ac-color hover:bg-color-bg-ac-1'"
      @click.stop="join"
    >
      {{ t("call.join") }}
    </button>
  </div>
</template>
