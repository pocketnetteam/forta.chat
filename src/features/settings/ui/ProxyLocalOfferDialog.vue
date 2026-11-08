<script setup lang="ts">
import { useProxyStore } from "@/entities/proxy";
import {
  configurePocketnetNodes,
  getSharedLocalNodeProxy,
  setNodeFailoverStickyIndex,
} from "@/shared/lib/pocketnet";

const { t } = useI18n();
const proxyStore = useProxyStore();

function onAccept(): void {
  proxyStore.acceptLocalOffer();
  const urls = proxyStore.gatewayBaseUrls();
  configurePocketnetNodes(urls);
  setNodeFailoverStickyIndex(0);
  void getSharedLocalNodeProxy().maybeDiscover();
  proxyStore.setHealth("ok", t("proxy.localReady"));
}

function onDismiss(): void {
  proxyStore.dismissLocalOffer();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="proxyStore.offerLocalPending"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('proxy.offerLocalTitle')"
      @click.self="onDismiss()"
    >
      <div class="mx-auto w-full max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
        <h3 class="text-base font-semibold text-text-color">
          {{ t("proxy.offerLocalTitle") }}
        </h3>
        <p class="mt-2 text-sm text-text-on-main-bg-color">
          {{ t("proxy.offerLocalBody") }}
        </p>
        <div class="mt-5 flex justify-end gap-3">
          <button
            type="button"
            class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
            @click="onDismiss()"
          >
            {{ t("proxy.offerLocalNo") }}
          </button>
          <button
            type="button"
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
            @click="onAccept()"
          >
            {{ t("proxy.offerLocalYes") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
