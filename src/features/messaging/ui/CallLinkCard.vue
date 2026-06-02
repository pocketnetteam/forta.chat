<script setup lang="ts">
import { Capacitor } from "@capacitor/core";
import type { CallLinkInfo } from "@/entities/chat/model/types";
import CallLinkIcon from "@/features/video-calls/ui/CallLinkIcon.vue";

interface Props {
  info: CallLinkInfo;
  isOwn?: boolean;
}

const props = withDefaults(defineProps<Props>(), { isOwn: false });
const { t } = useI18n();

// Capacitor Android WebView treats target=_blank as a no-op, so route native
// taps through @capacitor/browser; fall back to window.open elsewhere.
// (Same approach as MessageContent.handleLinkClick — WEE-42.)
async function join(): Promise<void> {
  const url = props.info.url;
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch (err) {
    console.error("[CallLinkCard] Browser.open failed, falling back:", err);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
</script>

<template>
  <div class="flex items-center gap-3" data-test="call-link-card">
    <CallLinkIcon size-class="h-10 w-10" />
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
