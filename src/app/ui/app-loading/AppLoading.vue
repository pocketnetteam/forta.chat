<script setup lang="ts">
import { computed, ref } from "vue";
import { bootStatus } from "@/app/model/boot-status";
import { tRaw, type TranslationKey } from "@/shared/lib/i18n";

const t = tRaw;
const state = computed(() => bootStatus.state.value);
const error = computed(() => bootStatus.error.value);

const stepKeys: Record<string, TranslationKey> = {
  scripts: "boot.loadingScripts",
  tor: "boot.secureConnection",
  auth: "boot.authenticating",
  matrix: "boot.connectingServer",
  sync: "boot.syncingMessages",
};

const stepLabel = computed(() => {
  const key = stepKeys[bootStatus.currentStep.value];
  return key ? t(key) : t("boot.loading");
});

const clearing = ref(false);

const retry = () => location.reload();

const clearAndRetry = async () => {
  clearing.value = true;
  try {
    // Delete all IndexedDB databases owned by the app.
    // indexedDB.databases() is unavailable in older Firefox — fall back to known db names.
    const deleteDb = (name: string) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((db) => deleteDb(db.name!)));
    } else {
      // Best-effort: delete known database names
      const addr = localStorage.getItem("bastyon-chat-address") ?? "";
      const knownDbs = [
        `bastyon-chat-${addr}`,
        "messages",
        "events",
        "files",
      ];
      await Promise.all(knownDbs.filter(Boolean).map(deleteDb));
    }
    localStorage.clear();
  } catch (e) {
    console.warn("[BOOT] clearAndRetry cleanup error:", e);
  }
  location.reload();
};
</script>

<template>
  <div class="fixed inset-0 flex items-center justify-center bg-[#011621]">
    <div class="flex flex-col items-center gap-4">
      <!-- Booting: spinner + step label -->
      <template v-if="state === 'booting'">
        <div
          class="h-10 w-10 shrink-0 contain-strict animate-spin rounded-full border-4 border-white/20 border-t-white"
        />
        <span class="text-sm text-white/60">{{ stepLabel }}</span>
      </template>

      <!-- Error: message + action buttons -->
      <template v-else-if="state === 'error'">
        <div
          class="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20 text-2xl text-red-400"
        >
          !
        </div>

        <p class="text-sm text-red-400">{{ t("boot.failed") }}</p>
        <p v-if="error" class="max-w-xs text-center text-xs text-white/40">
          {{ error }}
        </p>

        <button
          class="mt-2 rounded-lg bg-white/10 px-5 py-2 text-sm text-white transition-colors hover:bg-white/20"
          @click="retry"
        >
          {{ t("boot.retry") }}
        </button>

        <button
          class="text-xs text-white/30 transition-colors hover:text-white/50"
          :disabled="clearing"
          @click="clearAndRetry"
        >
          {{ clearing ? t("boot.clearing") : t("boot.clearCache") }}
        </button>
      </template>
    </div>
  </div>
</template>
