<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useWallet } from "../model/use-wallet";
import { useWalletStore, formatPkoin } from "../model/wallet-store";
import { useMessages } from "@/features/messaging/model/use-messages";
import Modal from "@/shared/ui/modal/Modal.vue";

const props = defineProps<{ show: boolean; receiverAddress: string; receiverName: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();
const { estimateFees, sendTransfer } = useWallet();
const walletStore = useWalletStore();
const { sendTransferMessage } = useMessages();

const amount = ref("");
const message = ref("");
const feeDirection = ref<"exclude" | "include">("exclude");
const fees = ref<number | null>(null);
const sending = ref(false);
const error = ref("");
const feesLoading = ref(false);

const numericAmount = computed(() => {
  const n = parseFloat(amount.value);
  return isNaN(n) || n <= 0 ? 0 : n;
});

const total = computed(() => {
  if (fees.value === null || numericAmount.value <= 0) return 0;
  return feeDirection.value === "exclude"
    ? numericAmount.value + fees.value
    : numericAmount.value;
});

const canCalculate = computed(() => numericAmount.value > 0 && !feesLoading.value);
const canSend = computed(() => {
  if (fees.value === null || numericAmount.value <= 0 || sending.value) return false;
  if (walletStore.balance !== null && total.value > walletStore.balance) return false;
  return true;
});

const insufficientBalance = computed(() => {
  if (walletStore.balance === null || fees.value === null) return false;
  return total.value > walletStore.balance;
});

// Hint text explaining why button is disabled
const sendButtonHint = computed(() => {
  if (sending.value) return "";
  if (numericAmount.value <= 0) return t("wallet.enterAmount");
  if (fees.value === null) return t("wallet.calculateFirst");
  if (insufficientBalance.value) return t("wallet.insufficientBalance");
  return "";
});

const calculateFees = async () => {
  if (!canCalculate.value) return;
  error.value = "";
  feesLoading.value = true;
  try {
    fees.value = await estimateFees(props.receiverAddress, numericAmount.value, feeDirection.value);
  } catch (e) {
    error.value = String(e);
    fees.value = null;
  } finally {
    feesLoading.value = false;
  }
};

const handleSend = async () => {
  if (!canSend.value) return;
  sending.value = true;
  error.value = "";
  try {
    const txId = await sendTransfer(
      props.receiverAddress,
      numericAmount.value,
      feeDirection.value,
      message.value || undefined,
    );
    await sendTransferMessage(txId, numericAmount.value, props.receiverAddress, message.value || undefined);
    resetAndClose();
  } catch (e) {
    error.value = t("wallet.transactionError");
  } finally {
    sending.value = false;
  }
};

const resetAndClose = () => {
  amount.value = "";
  message.value = "";
  feeDirection.value = "exclude";
  fees.value = null;
  error.value = "";
  sending.value = false;
  emit("close");
};

// Reset fees when amount or direction changes
watch([amount, feeDirection], () => {
  fees.value = null;
});

// Refresh balance when modal opens
watch(() => props.show, (v) => {
  if (v) walletStore.refresh();
});
</script>

<template>
  <Modal :show="show" @close="resetAndClose">
    <div class="flex flex-col gap-5">
      <!-- Header -->
      <div class="flex items-center gap-3">
        <div class="flex h-11 w-11 items-center justify-center rounded-full bg-color-bg-ac text-white">
          <svg width="22" height="22" viewBox="0 0 18 18" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-semibold text-text-color">{{ t("wallet.sendPkoin") }}</h3>
          <p class="truncate text-xs text-text-on-main-bg-color">{{ receiverName }}</p>
        </div>
        <!-- Balance badge -->
        <div v-if="walletStore.balance !== null" class="shrink-0 rounded-lg bg-neutral-grad-0 px-2.5 py-1">
          <span class="text-[10px] uppercase text-text-on-main-bg-color">{{ t("wallet.balance") }}</span>
          <div class="text-sm font-bold text-text-color">{{ formatPkoin(walletStore.balance) }} <span class="text-[10px] font-normal text-text-on-main-bg-color">PKOIN</span></div>
        </div>
      </div>

      <!-- Amount input -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-text-on-main-bg-color">{{ t("wallet.amount") }}</label>
        <div class="flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 transition-colors" :class="insufficientBalance ? 'border-color-bad' : 'border-neutral-grad-0 focus-within:border-color-bg-ac'">
          <input
            v-model="amount"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            class="flex-1 bg-transparent text-lg font-semibold text-text-color outline-none placeholder:text-neutral-grad-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span class="text-sm font-bold text-text-on-main-bg-color">PKOIN</span>
        </div>
        <p v-if="insufficientBalance" class="mt-1 text-xs text-color-bad">{{ t("wallet.insufficientBalance") }}</p>
      </div>

      <!-- Message input -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-text-on-main-bg-color">{{ t("wallet.message") }}</label>
        <input
          v-model="message"
          type="text"
          maxlength="200"
          :placeholder="t('wallet.message')"
          class="w-full rounded-xl border-2 border-neutral-grad-0 bg-transparent px-3 py-2.5 text-sm text-text-color outline-none placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
        />
      </div>

      <!-- Fee direction toggle -->
      <div class="flex gap-2">
        <button
          class="flex-1 rounded-xl border-2 px-3 py-2 text-xs font-medium transition-colors"
          :class="feeDirection === 'exclude' ? 'border-color-bg-ac bg-color-bg-ac/10 text-color-txt-ac' : 'border-neutral-grad-0 text-text-on-main-bg-color hover:bg-neutral-grad-0/50'"
          @click="feeDirection = 'exclude'"
        >
          {{ t("wallet.senderPaysFees") }}
        </button>
        <button
          class="flex-1 rounded-xl border-2 px-3 py-2 text-xs font-medium transition-colors"
          :class="feeDirection === 'include' ? 'border-color-bg-ac bg-color-bg-ac/10 text-color-txt-ac' : 'border-neutral-grad-0 text-text-on-main-bg-color hover:bg-neutral-grad-0/50'"
          @click="feeDirection = 'include'"
        >
          {{ t("wallet.receiverPaysFees") }}
        </button>
      </div>

      <!-- Fee summary (appears after calculation) -->
      <transition name="fee-reveal">
        <div v-if="fees !== null" class="rounded-xl bg-neutral-grad-0/40 px-4 py-3">
          <div class="flex justify-between text-sm">
            <span class="text-text-on-main-bg-color">{{ t("wallet.fees") }}</span>
            <span class="font-medium text-text-color">{{ fees.toFixed(4) }} PKOIN</span>
          </div>
          <div class="mt-2 flex justify-between border-t border-neutral-grad-0 pt-2 text-sm">
            <span class="font-medium text-text-on-main-bg-color">{{ t("wallet.total") }}</span>
            <span class="text-base font-bold text-text-color">{{ total.toFixed(4) }} PKOIN</span>
          </div>
        </div>
      </transition>

      <!-- Error -->
      <p v-if="error" class="rounded-lg bg-color-bad/10 px-3 py-2 text-xs font-medium text-color-bad">{{ error }}</p>

      <!-- Action buttons -->
      <div class="flex flex-col gap-2">
        <!-- Step 1: Calculate fees (shown when fees not yet calculated) -->
        <button
          v-if="fees === null"
          :disabled="!canCalculate"
          class="relative w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all"
          :class="canCalculate
            ? 'bg-neutral-grad-0 text-text-color hover:bg-neutral-grad-2/30 cursor-pointer'
            : 'bg-neutral-grad-0 text-text-on-main-bg-color opacity-50 cursor-not-allowed'"
          @click="calculateFees"
        >
          <span v-if="feesLoading" class="inline-flex items-center gap-2">
            <span class="inline-block h-4 w-4 shrink-0 contain-strict animate-spin rounded-full border-2 border-current border-t-transparent" />
            {{ t("wallet.calculateFees") }}
          </span>
          <span v-else>{{ t("wallet.calculateFees") }}</span>
        </button>

        <!-- Step 2: Send button (shown after fees calculated) -->
        <button
          :disabled="!canSend"
          class="relative w-full rounded-xl px-4 py-3 text-sm font-bold transition-all"
          :class="canSend
            ? 'bg-color-bg-ac text-white hover:opacity-90 cursor-pointer'
            : fees !== null
              ? 'bg-color-bg-ac text-white opacity-40 cursor-not-allowed'
              : 'bg-neutral-grad-0 text-text-on-main-bg-color opacity-40 cursor-not-allowed'"
          @click="handleSend"
        >
          <span v-if="sending" class="inline-flex items-center gap-2">
            <span class="inline-block h-4 w-4 shrink-0 contain-strict animate-spin rounded-full border-2 border-white border-t-transparent" />
            {{ t("wallet.send") }}
          </span>
          <span v-else>{{ t("wallet.send") }} {{ numericAmount > 0 && fees !== null ? `${numericAmount} PKOIN` : '' }}</span>
        </button>

        <!-- Hint for why button is disabled -->
        <p v-if="sendButtonHint" class="text-center text-[11px] text-text-on-main-bg-color">
          {{ sendButtonHint }}
        </p>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.fee-reveal-enter-active {
  transition: max-height 0.25s ease, opacity 0.25s ease;
}
.fee-reveal-leave-active {
  transition: max-height 0.15s ease, opacity 0.15s ease;
}
.fee-reveal-enter-from,
.fee-reveal-leave-to {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
}
.fee-reveal-enter-to,
.fee-reveal-leave-from {
  max-height: 100px;
  opacity: 1;
}
</style>
