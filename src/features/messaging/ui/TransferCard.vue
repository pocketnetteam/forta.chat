<script setup lang="ts">
import type { Message } from "@/entities/chat";
import { useChatStore } from "@/entities/chat";

const props = defineProps<{ message: Message; isOwn: boolean }>();
const chatStore = useChatStore();
const { t } = useI18n();

const transfer = computed(() => props.message.transferInfo!);

const fromName = computed(() => chatStore.getDisplayName(transfer.value.from));
const toName = computed(() => chatStore.getDisplayName(transfer.value.to));

const explorerUrl = computed(() =>
  `https://explorer.pocketnet.app/tx/${transfer.value.txId}`,
);

/** Normalize amount — handle both PKOIN and satoshi values.
 *  If amount > 1000, assume it's in satoshis and convert. */
const displayAmount = computed(() => {
  const raw = transfer.value.amount;
  const val = typeof raw === "string" ? parseFloat(raw) : raw;
  if (!val || isNaN(val)) return "0";
  // If value looks like satoshis (> 1000), convert to PKOIN
  const pkoin = val > 1000 ? val / 100_000_000 : val;
  // Format: remove trailing zeros but keep at least 1 decimal
  if (pkoin >= 1) return pkoin.toFixed(2).replace(/\.?0+$/, "");
  return pkoin.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
});
</script>

<template>
  <div
    class="relative flex flex-col gap-2 overflow-hidden rounded-xl p-3"
    :class="isOwn ? 'bg-white/10' : 'bg-color-bg-ac/8'"
  >
    <!-- PKOIN amount row -->
    <div class="flex items-center gap-2.5">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        :class="isOwn ? 'bg-white/15' : 'bg-color-bg-ac/15'"
      >
        <svg
          width="18" height="18" viewBox="0 0 18 18" fill="currentColor"
          :class="isOwn ? 'text-white' : 'text-color-bg-ac'"
        >
          <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
        </svg>
      </div>
      <div class="flex items-baseline gap-1.5">
        <span class="text-xl font-bold leading-tight" :class="isOwn ? 'text-white' : 'text-text-color'">
          {{ displayAmount }}
        </span>
        <span class="text-sm font-semibold opacity-70" :class="isOwn ? 'text-white' : 'text-text-color'">
          PKOIN
        </span>
      </div>
    </div>

    <!-- From → To -->
    <div class="flex items-center gap-1 text-xs" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
      <span class="font-medium" :class="isOwn ? 'text-white/80' : 'text-text-color'">{{ fromName }}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
      <span class="font-medium" :class="isOwn ? 'text-white/80' : 'text-text-color'">{{ toName }}</span>
    </div>

    <!-- Optional message -->
    <p
      v-if="transfer.message && transfer.message !== `Sent ${displayAmount} PKOIN`"
      class="text-chat-base"
      :class="isOwn ? 'text-white/80' : 'text-text-color'"
    >
      {{ transfer.message }}
    </p>

    <!-- Explorer link -->
    <a
      :href="explorerUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
      :class="isOwn ? 'text-white/50 hover:text-white/70' : 'text-color-bg-ac/70 hover:text-color-bg-ac'"
      @click.stop
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
      {{ t("wallet.viewTransaction") }}
    </a>
  </div>
</template>
