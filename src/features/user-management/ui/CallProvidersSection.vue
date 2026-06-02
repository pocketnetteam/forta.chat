<script setup lang="ts">
import { computed, ref } from "vue";
import { getChatDb, isChatDbReady, useLiveQuery, type CallProvider } from "@/shared/lib/local-db";
import CallLinkIcon from "@/features/video-calls/ui/CallLinkIcon.vue";
import CallProviderDialog from "./CallProviderDialog.vue";

const { t } = useI18n();

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
</script>

<template>
  <section class="space-y-4">
    <header class="space-y-1">
      <h3 class="text-base font-semibold text-text-color">{{ t("settings.callProviders.title") }}</h3>
      <p class="text-xs leading-relaxed text-text-on-main-bg-color">{{ t("settings.callProviders.description") }}</p>
    </header>

    <!-- Provider cards -->
    <ul v-if="hasProviders" class="space-y-2">
      <li
        v-for="p in providers"
        :key="p.id"
        class="group flex items-center gap-3 rounded-2xl border border-neutral-grad-0 bg-neutral-grad-0/40 p-3 transition-colors hover:border-neutral-grad-2"
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

    <!-- Empty state -->
    <div
      v-else
      class="rounded-2xl border border-dashed border-neutral-grad-2 px-4 py-6 text-center"
    >
      <CallLinkIcon size-class="mx-auto h-12 w-12" />
      <p class="mt-3 text-sm text-text-on-main-bg-color">{{ t("settings.callProviders.empty") }}</p>
    </div>

    <!-- Add button -->
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

    <CallProviderDialog
      v-if="dialogOpen"
      :show="dialogOpen"
      :provider="editing"
      @save="onSave"
      @close="closeDialog"
    />
  </section>
</template>
