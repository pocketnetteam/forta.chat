<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { UserAvatar, useUserStore } from "@/entities/user";
import { toTransactionExplorerUrl } from "@/shared/lib/bastyon-link";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import { confirmationsOf, formatPkoinExact } from "../model/transaction-summary";
import { useTransactionLoader } from "../model/use-transaction-loader";

interface Props {
  txid: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const authStore = useAuthStore();
const userStore = useUserStore();

// Open user profile in-app (provided by ChatWindow)
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

// Polls our node until the transaction reaches it (see use-transaction-loader).
const { summary, loading, start } = useTransactionLoader(
  toRef(props, "txid"),
  (txid, update) => authStore.loadTransaction(txid, update),
);

const explorerUrl = computed(() => toTransactionExplorerUrl(props.txid));
const shortTxid = computed(() => `${props.txid.slice(0, 10)}…${props.txid.slice(-8)}`);

const confirmations = computed(() =>
  summary.value ? confirmationsOf(summary.value, authStore.blockHeight) : 0,
);

const txDate = computed(() => {
  const time = summary.value?.time;
  if (!time) return "";
  return new Date(time * 1000).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
});

const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const nameOf = (address: string) => userStore.getUser(address)?.name || "";

watch(summary, (s) => {
  if (!s) return;
  for (const address of [...s.senders, ...s.recipients.map((r) => r.address)]) {
    userStore.loadUserIfMissing(address);
  }
  if (s.height) void authStore.ensureBlockHeight().catch(() => {});
});

function onOpen() {
  void openExternalUrl(explorerUrl.value);
}

function onRetry() {
  start(0, true);
}

function onParticipant(address: string) {
  if (openUserProfile) openUserProfile(address);
  else onOpen();
}

onMounted(() => start());
</script>

<template>
  <div
    class="my-1.5 w-[20rem] max-w-full overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
    data-testid="tx-link-card"
  >
    <!-- Header: label + status -->
    <div class="flex items-center gap-3 p-3 pb-2 sm:p-4 sm:pb-2">
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-wider"
          :class="isOwn ? 'text-white/60' : 'text-color-txt-ac'"
        >{{ t("txLink.label") }}</span>
        <span
          class="truncate font-mono text-xs"
          :class="isOwn ? 'text-white/80' : 'text-text-on-main-bg-color'"
        >{{ shortTxid }}</span>
      </div>
    </div>

    <!-- Loading skeleton — also while waiting for the tx to reach our node -->
    <div v-if="!summary && loading" class="flex flex-col gap-2 px-3 pb-3 sm:px-4" data-testid="tx-link-loading">
      <div class="h-7 w-32 animate-pulse rounded bg-neutral-grad-2" />
      <div class="h-10 w-full animate-pulse rounded-xl bg-neutral-grad-2" />
      <div class="h-10 w-full animate-pulse rounded-xl bg-neutral-grad-2" />
    </div>

    <!-- Not found / failed -->
    <div
      v-else-if="!summary"
      class="flex items-center gap-3 px-3 pb-3 text-sm sm:px-4"
      :class="isOwn ? 'text-white/80' : 'text-text-on-main-bg-color'"
      data-testid="tx-link-not-found"
    >
      <span class="flex-1">{{ t("txLink.notFound") }}</span>
      <button
        class="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
        :class="isOwn ? 'border-white/20 text-white hover:bg-white/10' : 'border-neutral-grad-1/50 text-text-color hover:bg-neutral-grad-0'"
        data-testid="tx-link-retry"
        @click.stop="onRetry"
      >{{ t("txLink.retry") }}</button>
    </div>

    <!-- Transaction -->
    <div v-else class="flex flex-col gap-2 px-3 pb-3 sm:px-4" data-testid="tx-link-details">
      <!-- Amount -->
      <div class="flex items-baseline gap-1.5">
        <span
          class="text-2xl font-bold leading-tight"
          :class="isOwn ? 'text-white' : 'text-text-color'"
          data-testid="tx-link-total"
        >{{ formatPkoinExact(summary.total) }}</span>
        <span class="text-sm font-semibold opacity-70" :class="isOwn ? 'text-white' : 'text-text-color'">PKOIN</span>
      </div>

      <!-- Senders -->
      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-medium" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">{{ t("txLink.from") }}</span>
        <button
          v-for="address in summary.senders"
          :key="`from-${address}`"
          class="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors"
          :class="isOwn ? 'bg-white/10 hover:bg-white/15' : 'bg-neutral-grad-0 hover:bg-neutral-grad-1/50'"
          data-testid="tx-link-sender"
          @click.stop="onParticipant(address)"
        >
          <UserAvatar :address="address" size="sm" />
          <div class="flex min-w-0 flex-1 flex-col">
            <span v-if="nameOf(address)" class="truncate text-sm font-medium" :class="isOwn ? 'text-white' : 'text-text-color'">{{ nameOf(address) }}</span>
            <span class="truncate font-mono text-[11px]" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'" :title="address">{{ shortAddress(address) }}</span>
          </div>
        </button>
      </div>

      <!-- Recipients -->
      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-medium" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">{{ t("txLink.to") }}</span>
        <button
          v-for="recipient in summary.recipients"
          :key="`to-${recipient.address}`"
          class="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors"
          :class="isOwn ? 'bg-white/10 hover:bg-white/15' : 'bg-neutral-grad-0 hover:bg-neutral-grad-1/50'"
          data-testid="tx-link-recipient"
          @click.stop="onParticipant(recipient.address)"
        >
          <UserAvatar :address="recipient.address" size="sm" />
          <div class="flex min-w-0 flex-1 flex-col">
            <span v-if="nameOf(recipient.address)" class="truncate text-sm font-medium" :class="isOwn ? 'text-white' : 'text-text-color'">{{ nameOf(recipient.address) }}</span>
            <span class="truncate font-mono text-[11px]" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'" :title="recipient.address">{{ shortAddress(recipient.address) }}</span>
          </div>
          <span class="shrink-0 text-sm font-semibold" :class="isOwn ? 'text-white' : 'text-color-good'">+{{ formatPkoinExact(recipient.amount) }}</span>
        </button>
      </div>

      <!-- Date + confirmation status -->
      <div class="flex items-center justify-between gap-2 text-[11px]" :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
        <span>{{ txDate }}</span>
        <span class="flex items-center gap-2">
          <span data-testid="tx-link-status">{{
            confirmations > 0 ? t("txLink.confirmations", { count: confirmations }) : t("txLink.unconfirmed")
          }}</span>
          <!-- Polling window over while still unmined: let the user ask again -->
          <button
            v-if="confirmations === 0 && !loading"
            class="font-medium underline-offset-2 hover:underline"
            data-testid="tx-link-recheck"
            @click.stop="onRetry"
          >{{ t("txLink.retry") }}</button>
        </span>
      </div>
    </div>

    <div class="px-3 pb-3 sm:px-4 sm:pb-4">
      <button
        class="w-full rounded-xl py-2 text-xs font-semibold text-white transition-colors sm:py-2.5 sm:text-sm"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        data-testid="tx-link-open"
        @click.stop="onOpen"
      >
        {{ t("txLink.open") }}
      </button>
    </div>
  </div>
</template>
