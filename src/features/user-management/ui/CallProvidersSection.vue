<script setup lang="ts">
import { computed, ref } from "vue";
import { Toggle } from "@/shared/ui/toggle";
import { getChatDb, isChatDbReady, useLiveQuery, type CallProvider } from "@/shared/lib/local-db";
import { useCallProviderSettings } from "@/features/video-calls/model/use-call-provider-settings";
import ProviderIcon from "@/features/video-calls/ui/ProviderIcon.vue";
import CallProviderDialog from "./CallProviderDialog.vue";

const { t } = useI18n();
const { useExternalProviders, setUseExternalProviders } = useCallProviderSettings();

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

async function onSave(value: Omit<CallProvider, "id">, id?: number): Promise<void> {
  if (!isChatDbReady()) return;
  const repo = getChatDb().callProviders;
  if (id !== undefined) {
    await repo.update(id, value);
  } else {
    await repo.add(value);
  }
  dialogOpen.value = false;
  editing.value = undefined;
}

async function remove(id?: number): Promise<void> {
  if (id === undefined || !isChatDbReady()) return;
  await getChatDb().callProviders.delete(id);
}

async function makeDefault(id?: number): Promise<void> {
  if (id === undefined || !isChatDbReady()) return;
  await getChatDb().callProviders.setDefault(id);
}
</script>

<template>
  <div class="space-y-3">
    <div>
      <h3 class="text-sm font-medium text-text-color">{{ t("settings.callProviders.title") }}</h3>
      <p class="mt-0.5 text-xs text-text-on-main-bg-color">{{ t("settings.callProviders.privacy") }}</p>
    </div>

    <!-- Global toggle -->
    <label class="flex items-center justify-between">
      <span class="text-sm text-text-color">{{ t("settings.callProviders.useExternal") }}</span>
      <Toggle :model-value="useExternalProviders" @update:model-value="setUseExternalProviders" />
    </label>

    <!-- Provider list -->
    <ul v-if="hasProviders" class="flex flex-col gap-2">
      <li
        v-for="p in providers"
        :key="p.id"
        class="flex items-center gap-3 rounded-xl border border-neutral-grad-2 px-3 py-2"
      >
        <ProviderIcon :kind="p.kind" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium text-text-color">{{ p.label }}</span>
            <span v-if="p.isDefault" class="rounded bg-color-bg-ac/15 px-1.5 py-0.5 text-[10px] font-medium text-color-bg-ac">
              {{ t("settings.callProviders.isDefault") }}
            </span>
          </div>
          <code class="block truncate text-xs text-text-on-main-bg-color">{{ p.urlTemplate }}</code>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            v-if="!p.isDefault"
            type="button"
            class="rounded-md px-2 py-1 text-xs text-text-on-main-bg-color hover:bg-neutral-grad-0"
            :title="t('settings.callProviders.makeDefault')"
            @click="makeDefault(p.id)"
          >★</button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs text-text-on-main-bg-color hover:bg-neutral-grad-0"
            @click="openEdit(p)"
          >{{ t("settings.callProviders.edit") }}</button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs text-color-bad hover:bg-color-bad/10"
            @click="remove(p.id)"
          >{{ t("settings.callProviders.delete") }}</button>
        </div>
      </li>
    </ul>
    <p v-else class="text-xs text-text-on-main-bg-color">{{ t("settings.callProviders.empty") }}</p>

    <button
      type="button"
      class="rounded-lg border border-neutral-grad-2 px-3 py-2 text-sm font-medium text-text-color hover:bg-neutral-grad-0"
      @click="openAdd"
    >
      + {{ t("settings.callProviders.add") }}
    </button>

    <CallProviderDialog
      v-if="dialogOpen"
      :show="dialogOpen"
      :provider="editing"
      @save="onSave"
      @close="dialogOpen = false; editing = undefined"
    />
  </div>
</template>
