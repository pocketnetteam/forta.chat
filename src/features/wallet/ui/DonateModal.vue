<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useWallet } from "../model/use-wallet";
import { useMessages } from "@/features/messaging/model/use-messages";

const props = defineProps<{ show: boolean; receiverAddress: string; receiverName: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();
const { getBalance, estimateFees, sendTransfer } = useWallet();
const { sendTransferMessage } = useMessages();

const amount = ref("");
const message = ref("");
const feeDirection = ref<"exclude" | "include">("exclude");
const balance = ref<number | null>(null);
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
  if (balance.value !== null && total.value > balance.value) return false;
  return true;
});

const insufficientBalance = computed(() => {
  if (balance.value === null || fees.value === null) return false;
  return total.value > balance.value;
});

const fetchBalance = async () => {
  try {
    balance.value = await getBalance();
  } catch {
    balance.value = null;
  }
};

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

// Fetch balance when modal opens
watch(() => props.show, (v) => {
  if (v) fetchBalance();
});
</script>

<template>
  <Modal :show="show" @close="resetAndClose">
    <div class="flex flex-col gap-4 p-5">
      <!-- Header -->
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac text-white">
          <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
          </svg>
        </div>
        <div>
          <h3 class="text-base font-semibold text-text-color">{{ t("wallet.sendPkoin") }}</h3>
          <p class="text-xs text-text-on-main-bg-color">{{ receiverName }}</p>
        </div>
      </div>

      <!-- Amount input -->
      <div>
        <label class="mb-1 block text-xs font-medium text-text-on-main-bg-color">{{ t("wallet.amount") }}</label>
        <div class="flex items-center gap-2 rounded-lg border border-neutral-grad-0 bg-transparent px-3 py-2 focus-within:border-color-bg-ac">
          <input
            v-model="amount"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            class="flex-1 bg-transparent text-sm text-text-color outline-none placeholder:text-text-on-main-bg-color/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span class="text-xs font-semibold text-text-on-main-bg-color">PKOIN</span>
        </div>
      </div>

      <!-- Message input -->
      <div>
        <label class="mb-1 block text-xs font-medium text-text-on-main-bg-color">{{ t("wallet.message") }}</label>
        <input
          v-model="message"
          type="text"
          maxlength="200"
          :placeholder="t('wallet.message')"
          class="w-full rounded-lg border border-neutral-grad-0 bg-transparent px-3 py-2 text-sm text-text-color outline-none placeholder:text-text-on-main-bg-color/50 focus:border-color-bg-ac"
        />
      </div>

      <!-- Fee direction toggle -->
      <div class="flex gap-2">
        <button
          class="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
          :class="feeDirection === 'exclude' ? 'border-color-bg-ac bg-color-bg-ac/10 text-color-bg-ac' : 'border-neutral-grad-0 text-text-on-main-bg-color'"
          @click="feeDirection = 'exclude'"
        >
          {{ t("wallet.senderPaysFees") }}
        </button>
        <button
          class="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
          :class="feeDirection === 'include' ? 'border-color-bg-ac bg-color-bg-ac/10 text-color-bg-ac' : 'border-neutral-grad-0 text-text-on-main-bg-color'"
          @click="feeDirection = 'include'"
        >
          {{ t("wallet.receiverPaysFees") }}
        </button>
      </div>

      <!-- Calculate fees button -->
      <button
        :disabled="!canCalculate"
        class="rounded-lg bg-neutral-grad-0 px-4 py-2 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-0/80 disabled:opacity-40"
        @click="calculateFees"
      >
        <span v-if="feesLoading" class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span v-else>{{ t("wallet.calculateFees") }}</span>
      </button>

      <!-- Fee / balance summary -->
      <div v-if="fees !== null" class="rounded-lg bg-neutral-grad-0/50 px-3 py-2 text-sm">
        <div class="flex justify-between">
          <span class="text-text-on-main-bg-color">{{ t("wallet.fees") }}</span>
          <span class="font-medium text-text-color">{{ fees.toFixed(4) }} PKOIN</span>
        </div>
        <div class="mt-1 flex justify-between border-t border-neutral-grad-0 pt-1">
          <span class="text-text-on-main-bg-color">{{ t("wallet.total") }}</span>
          <span class="font-semibold text-text-color">{{ total.toFixed(4) }} PKOIN</span>
        </div>
      </div>

      <div v-if="balance !== null" class="text-xs text-text-on-main-bg-color">
        {{ t("wallet.balance") }}: <span class="font-semibold">{{ balance.toFixed(4) }} PKOIN</span>
      </div>

      <!-- Error -->
      <p v-if="insufficientBalance" class="text-xs font-medium text-color-bad">{{ t("wallet.insufficientBalance") }}</p>
      <p v-else-if="error" class="text-xs font-medium text-color-bad">{{ error }}</p>

      <!-- Send button -->
      <button
        :disabled="!canSend"
        class="rounded-lg bg-color-bg-ac px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
        @click="handleSend"
      >
        <span v-if="sending" class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
        <span v-else>{{ t("wallet.send") }}</span>
      </button>
    </div>
  </Modal>
</template>
