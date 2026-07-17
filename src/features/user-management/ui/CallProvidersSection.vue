<script setup lang="ts">
import { computed, ref } from "vue";
import { Toggle } from "@/shared/ui/toggle";
import { getChatDb, isChatDbReady, useLiveQuery, type CallProvider } from "@/shared/lib/local-db";
import { useCallProviderSettings } from "@/features/video-calls";
import CallLinkIcon from "@/features/video-calls/ui/CallLinkIcon.vue";
import CallProviderDialog from "./CallProviderDialog.vue";

const { t } = useI18n();
const { autoOpenAfterSend, setAutoOpenAfterSend } = useCallProviderSettings();

// Reactive provider list straight from Dexie (local-only).
const { data: providers } = useLiveQuery<CallProvider[]>(
  () => (isChatDbReady() ? getChatDb().callProviders.toArray() : Promise.resolve([])),
  undefined,
  [],
);
const hasProviders = computed(() => (providers.value?.length ?? 0) > 0);

const dialogOpen = ref(false);
const editing = ref<CallProvider | undefined>(undefined);

function openAdd(): void {
  editing.value = undefined;
  dialogOpen.value = true;
}
function openEdit(provider: CallProvider): void {
  editing.value = provider;
  dialogOpen.value = true;
}
function closeDialog(): void {
  dialogOpen.value = false;
  editing.value = undefined;
}

async function onSave(value: Omit<CallProvider, "id">, id?: number): Promise<void> {
  if (!isChatDbReady()) return;
  const repo = getChatDb().callProviders;
  if (id !== undefined) await repo.update(id, value);
  else await repo.add(value);
  closeDialog();
}

async function remove(id?: number): Promise<void> {
  if (id === undefined || !isChatDbReady()) return;
  await getChatDb().callProviders.delete(id);
}

const steps = computed(() => [
  t("settings.callProviders.how.step1"),
  t("settings.callProviders.how.step2"),
  t("settings.callProviders.how.step3"),
]);
</script>

<template>
  <div class="space-y-7">
    <!-- How it works -->
    <section class="rounded-2xl border border-neutral-grad-0 bg-neutral-grad-0/40 p-4">
      <div class="flex items-center gap-2">
        <CallLinkIcon size-class="h-9 w-9" />
        <h3 class="text-sm font-semibold text-text-color">{{ t("settings.callProviders.how.title") }}</h3>
      </div>
      <p class="mt-2 text-xs leading-relaxed text-text-on-main-bg-color">
        {{ t("settings.callProviders.how.intro") }}
      </p>
      <ol class="mt-3 space-y-2">
        <li v-for="(step, i) in steps" :key="i" class="flex gap-2.5 text-xs text-text-color">
          <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-color-bg-ac/15 text-[11px] font-semibold text-color-bg-ac">{{ i + 1 }}</span>
          <span class="leading-relaxed">{{ step }}</span>
        </li>
      </ol>
      <p class="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-text-on-main-bg-color">
        <svg class="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {{ t("settings.callProviders.privacy") }}
      </p>
    </section>

    <!-- Behaviour sub-setting -->
    <section class="space-y-2">
      <h3 class="text-sm font-medium text-text-color">{{ t("settings.callProviders.behaviour") }}</h3>
      <label class="flex items-start justify-between gap-4 rounded-xl border border-neutral-grad-0 p-3">
        <span class="min-w-0">
          <span class="block text-sm text-text-color">{{ t("settings.callProviders.autoOpen") }}</span>
          <span class="mt-0.5 block text-xs leading-relaxed text-text-on-main-bg-color">{{ t("settings.callProviders.autoOpenHint") }}</span>
        </span>
        <Toggle :model-value="autoOpenAfterSend" @update:model-value="setAutoOpenAfterSend" />
      </label>
    </section>

    <!-- Methods list -->
    <section class="space-y-3">
      <h3 class="text-sm font-medium text-text-color">{{ t("settings.callProviders.yourMethods") }}</h3>

      <ul v-if="hasProviders" class="space-y-2">
        <li
          v-for="p in providers"
          :key="p.id"
          class="flex items-center gap-3 rounded-2xl border border-neutral-grad-0 bg-neutral-grad-0/40 p-3 transition-colors hover:border-neutral-grad-2"
        >
          <CallLinkIcon size-class="h-11 w-11" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-text-color">{{ p.label }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ p.urlTemplate }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="flex h-9 w-9 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-2/30"
              :title="t('settings.callProviders.edit')"
              :aria-label="t('settings.callProviders.edit')"
              @click="openEdit(p)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              type="button"
              class="flex h-9 w-9 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-color-bad/10"
              :title="t('settings.callProviders.delete')"
              :aria-label="t('settings.callProviders.delete')"
              @click="remove(p.id)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </li>
      </ul>

      <div v-else class="rounded-2xl border border-dashed border-neutral-grad-2 px-4 py-6 text-center">
        <CallLinkIcon size-class="mx-auto h-12 w-12" />
        <p class="mt-3 text-sm text-text-on-main-bg-color">{{ t("settings.callProviders.empty") }}</p>
      </div>

      <button
        type="button"
        class="flex w-full items-center justify-center gap-2 rounded-xl bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
        @click="openAdd"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {{ t("settings.callProviders.add") }}
      </button>
    </section>

    <CallProviderDialog
      v-if="dialogOpen"
      :show="dialogOpen"
      :provider="editing"
      @save="onSave"
      @close="closeDialog"
    />
  </div>
</template>
