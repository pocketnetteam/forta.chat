<script setup lang="ts">
import { useProxyStore, type ProxyListItem } from "@/entities/proxy";
import {
  getSharedLocalNodeProxy,
  setNodeFailoverStickyIndex,
  configurePocketnetNodes,
} from "@/shared/lib/pocketnet";
import { SettingsSection } from "@/shared/ui/settings-section";

const { t } = useI18n();
const proxyStore = useProxyStore();
const showPicker = ref(false);

const healthLabel = computed(() => {
  switch (proxyStore.health) {
    case "checking":
      return t("proxy.healthChecking");
    case "ok":
      return proxyStore.healthDetail || t("proxy.healthOk");
    case "error":
      return proxyStore.healthDetail || t("proxy.healthError");
    default:
      return t("proxy.healthIdle");
  }
});

const healthColor = computed(() => {
  switch (proxyStore.health) {
    case "ok":
      return "text-color-good";
    case "error":
      return "text-color-bad";
    case "checking":
      return "text-color-star-yellow";
    default:
      return "text-text-on-main-bg-color";
  }
});

async function refreshHealth(): Promise<void> {
  proxyStore.setHealth("checking");
  try {
    if (proxyStore.shouldUseLocal()) {
      const ok = await getSharedLocalNodeProxy().ping();
      proxyStore.setHealth(ok ? "ok" : "error", ok ? t("proxy.localReady") : t("proxy.localEmpty"));
      return;
    }
    const urls = proxyStore.gatewayBaseUrls();
    const target = urls[0];
    if (!target) {
      proxyStore.setHealth("error", t("proxy.healthError"));
      return;
    }
    const res = await fetch(`${target}/rpc/getnodeinfo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "getnodeinfo", parameters: [] }),
    });
    if (!res.ok) {
      proxyStore.setHealth("error", `HTTP ${res.status}`);
      return;
    }
    proxyStore.setHealth("ok", target.replace(/^https?:\/\//, ""));
  } catch (e) {
    proxyStore.setHealth(
      "error",
      e instanceof Error ? e.message : t("proxy.healthError"),
    );
  }
}

function applySelection(item: ProxyListItem): void {
  if (!item.available) return;
  proxyStore.select(item.id);
  showPicker.value = false;

  const urls = proxyStore.gatewayBaseUrls();
  configurePocketnetNodes(urls);
  if (proxyStore.mode === "gateway" && proxyStore.pinnedGatewayId) {
    const idx = urls.findIndex((u) => u.includes(proxyStore.pinnedGatewayId!));
    if (idx >= 0) setNodeFailoverStickyIndex(idx);
  } else if (proxyStore.mode === "auto") {
    setNodeFailoverStickyIndex(0);
  }

  void refreshHealth();
  if (proxyStore.shouldUseLocal()) {
    void getSharedLocalNodeProxy().maybeDiscover();
  }
}

onMounted(() => {
  void refreshHealth();
});
</script>

<template>
  <SettingsSection
    :title="t('proxy.title')"
    :description="t('proxy.description')"
  >
    <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-text-color">
            {{ proxyStore.currentLabel }}
          </p>
          <p
            class="mt-0.5 truncate text-xs"
            :class="[healthColor, proxyStore.health === 'checking' ? 'animate-pulse' : '']"
          >
            {{ healthLabel }}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-neutral-grad-0 px-3 py-1.5 text-xs font-medium text-text-color transition-colors hover:bg-neutral-grad-0"
          @click="showPicker = true"
        >
          {{ t("proxy.change") }}
        </button>
      </div>
    </div>
  </SettingsSection>

  <Teleport to="body">
    <div
      v-if="showPicker"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      @click.self="showPicker = false"
    >
      <div
        class="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-background-secondary-theme p-4 shadow-xl sm:rounded-2xl"
      >
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-text-color">{{ t("proxy.pickTitle") }}</h3>
          <button
            type="button"
            class="rounded-lg px-2 py-1 text-sm text-text-on-main-bg-color hover:bg-neutral-grad-0"
            @click="showPicker = false"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
        <ul class="space-y-1">
          <li
            v-for="item in proxyStore.listItems"
            :key="item.id"
          >
            <button
              type="button"
              class="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors"
              :class="[
                item.available
                  ? 'hover:bg-neutral-grad-0'
                  : 'cursor-not-allowed opacity-50',
                proxyStore.currentSelectionId === item.id
                  ? 'bg-color-bg-ac/10 ring-1 ring-color-bg-ac'
                  : '',
              ]"
              :disabled="!item.available"
              @click="applySelection(item)"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-text-color">{{ item.label }}</p>
                <p
                  v-if="item.detail"
                  class="mt-0.5 truncate text-xs text-text-on-main-bg-color"
                >
                  {{ item.detail }}
                </p>
              </div>
              <span
                v-if="proxyStore.currentSelectionId === item.id"
                class="mt-0.5 text-xs font-medium text-color-bg-ac"
              >
                ✓
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>
