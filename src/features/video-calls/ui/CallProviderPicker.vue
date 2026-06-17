<script setup lang="ts">
import { computed } from "vue";
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/context-menu";
import { isNative, isElectron } from "@/shared/lib/platform";
import { useDesktop } from "@/shared/lib/composables/use-media-query";
import CallLinkIcon from "./CallLinkIcon.vue";
import type { CallOption } from "../model/call-action";

interface Props {
  show: boolean;
  options: CallOption[];
  /** Anchor for the desktop context-menu presentation. */
  x?: number;
  y?: number;
}

const props = withDefaults(defineProps<Props>(), { x: 0, y: 0 });
const emit = defineEmits<{ pick: [option: CallOption]; close: [] }>();

const { t } = useI18n();

// Presentation is driven by viewport width, not pointer type: at a mobile /
// tablet resolution (incl. desktop browsers resized narrow) we want the bottom
// sheet; only a desktop-width layout gets the anchored context menu. Reactive
// to resize via useDesktop() (≥1024px). Native shells always use the sheet.
// (WEE-57)
const isDesktopWidth = useDesktop();
const useMenu = computed(() => !isNative && (isElectron || isDesktopWidth.value));

const PHONE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>';
const LINK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// Context-menu items: action = option index (stable, simple to map back).
const menuItems = computed<ContextMenuItem[]>(() =>
  props.options.map((option, i) => ({
    action: String(i),
    icon: option.type === "native" ? PHONE_ICON : LINK_ICON,
    label: option.type === "native" ? t("call.fortaNative") : option.provider.label,
  })),
);

function onMenuSelect(action: string): void {
  const option = props.options[Number(action)];
  if (option) emit("pick", option);
}
</script>

<template>
  <!-- Desktop: anchored context menu -->
  <ContextMenu
    v-if="useMenu"
    :show="props.show"
    :x="props.x"
    :y="props.y"
    :items="menuItems"
    @select="onMenuSelect"
    @close="emit('close')"
  >
    <template #header>
      <div class="px-4 pb-1.5 pt-1 text-xs font-medium text-text-on-main-bg-color">
        {{ t("call.picker.title") }}
      </div>
    </template>
  </ContextMenu>

  <!-- Touch / native: bottom sheet -->
  <BottomSheet v-else :show="props.show" :aria-label="t('call.picker.title')" @close="emit('close')">
    <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("call.picker.title") }}</h3>
    <ul class="flex flex-col gap-1">
      <li v-for="(option, i) in props.options" :key="i">
        <button
          type="button"
          data-test="picker-option"
          :data-test-native="option.type === 'native' ? 'true' : undefined"
          class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-grad-0"
          @click="emit('pick', option)"
        >
          <template v-if="option.type === 'native'">
            <span class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-color-bg-ac text-text-on-bg-ac-color" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
              </svg>
            </span>
            <span class="font-medium text-text-color">{{ t("call.fortaNative") }}</span>
          </template>
          <template v-else>
            <CallLinkIcon size-class="h-10 w-10" />
            <span class="min-w-0">
              <span class="block truncate font-medium text-text-color">{{ option.provider.label }}</span>
              <span class="block truncate text-xs text-text-on-main-bg-color">{{ option.provider.urlTemplate }}</span>
            </span>
          </template>
        </button>
      </li>
    </ul>
  </BottomSheet>
</template>
