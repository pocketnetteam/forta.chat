<script setup lang="ts">
import { toTransactionExplorerUrl } from "@/shared/lib/bastyon-link";
import { openExternalUrl } from "@/shared/lib/open-external-url";

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const explorerUrl = computed(() => toTransactionExplorerUrl(props.txid));
const shortTxid = computed(() => `${props.txid.slice(0, 10)}…${props.txid.slice(-8)}`);

function onOpen() {
  void openExternalUrl(explorerUrl.value);
}
</script>

<template>
  <div
    class="my-1.5 w-[20rem] max-w-full cursor-pointer overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
    @click.stop="onOpen"
  >
    <div class="flex items-center gap-3 p-3 sm:p-4">
      <div
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
      </div>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-wider"
          :class="isOwn ? 'text-white/60' : 'text-color-txt-ac'"
        >{{ t("txLink.label") }}</span>
        <span
          class="truncate font-mono text-xs sm:text-sm"
          :class="isOwn ? 'text-white' : 'text-text-color'"
        >{{ shortTxid }}</span>
      </div>
    </div>
    <div class="px-3 pb-3 sm:px-4 sm:pb-4">
      <button
        class="w-full rounded-xl py-2 text-xs font-semibold text-white transition-colors sm:py-2.5 sm:text-sm"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        @click.stop="onOpen"
      >
        {{ t("txLink.open") }}
      </button>
    </div>
  </div>
</template>
