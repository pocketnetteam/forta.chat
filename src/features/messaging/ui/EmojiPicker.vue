<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useThemeStore } from "@/entities/theme";
import { EMOJI_CATEGORIES, searchEmojis } from "@/shared/lib/emoji-data";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import EmojiKitchenBar from "./EmojiKitchenBar.vue";
import GifPicker from "./GifPicker.vue";
import type { TenorGif } from "@/shared/lib/tenor";

const isMobile = useMobile();

const PANEL_W = 370;
const PANEL_H = 420;
const PAD = 8;

interface Props {
  show: boolean;
  x?: number;
  y?: number;
  mode?: "reaction" | "input";
}

const props = withDefaults(defineProps<Props>(), {
  x: 0,
  y: 0,
  mode: "reaction",
});
const emit = defineEmits<{
  close: [];
  select: [emoji: string];
  selectGif: [gif: TenorGif];
  selectKitchen: [imageUrl: string];
}>();

type PickerTab = "emoji" | "gif";
const activeTab = ref<PickerTab>("emoji");
const lastSelectedEmoji = ref<string | null>(null);

const themeStore = useThemeStore();
const { t } = useI18n();

const search = ref("");
const activeCategoryIndex = ref(0);
const searchInputRef = ref<HTMLInputElement>();
const gridRef = ref<HTMLElement>();
const sectionRefs = ref<HTMLElement[]>([]);
let isScrollingToCategory = false;

// Reset state when picker opens
watch(() => props.show, (v) => {
  if (v) {
    search.value = "";
    activeCategoryIndex.value = 0;
    activeTab.value = "emoji";
    lastSelectedEmoji.value = null;
    nextTick(() => {
      searchInputRef.value?.focus();
      if (gridRef.value) gridRef.value.scrollTop = 0;
    });
  }
});

// Responsive panel: clamp to viewport on small screens
const panelStyle = computed(() => {
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;

  // Mobile: full-width bottom panel (use CSS units for resize/rotation reactivity)
  if (isMobile.value) {
    return {
      left: "0px",
      top: "auto",
      bottom: "0px",
      width: "100%",
      height: "min(55dvh, 420px)",
      borderRadius: "16px 16px 0 0",
    };
  }

  const panelW = Math.min(PANEL_W, vw - PAD * 2);
  const panelH = Math.min(PANEL_H, vh - PAD * 2);

  let left = Math.max(PAD, Math.min(props.x, vw - panelW - PAD));

  const spaceAbove = props.y - PAD;
  const spaceBelow = vh - props.y - PAD;

  let top: number;
  if (spaceAbove >= panelH) {
    top = props.y - panelH;
  } else if (spaceBelow >= panelH) {
    top = props.y;
  } else {
    if (spaceAbove >= spaceBelow) {
      top = PAD;
    } else {
      top = vh - panelH - PAD;
    }
  }

  top = Math.max(PAD, Math.min(top, vh - panelH - PAD));

  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${panelW}px`,
    height: `${panelH}px`,
  };
});

const filteredEmojis = computed(() => {
  if (!search.value) return null;
  const results = searchEmojis(search.value);
  return results.length > 0 ? results : null;
});

const handleSelect = (emoji: string) => {
  lastSelectedEmoji.value = emoji;
  emit("select", emoji);
  if (props.mode === "reaction") {
    emit("close");
  }
};

/** All sections: Recent (if any) + standard categories */
const allSections = computed(() => {
  const sections: { key: string; name: string; icon: string; emojis: string[] }[] = [];
  if (themeStore.recentEmojis.length > 0) {
    sections.push({ key: "recent", name: "Recent", icon: "\u{1F552}", emojis: [...themeStore.recentEmojis] });
  }
  EMOJI_CATEGORIES.forEach((cat) => {
    sections.push({ key: cat.name, name: cat.name, icon: cat.icon, emojis: cat.emojis });
  });
  return sections;
});

const scrollToSection = (index: number) => {
  activeCategoryIndex.value = index;
  const el = sectionRefs.value[index];
  if (el && gridRef.value) {
    isScrollingToCategory = true;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    // Release lock after scroll settles
    setTimeout(() => { isScrollingToCategory = false; }, 400);
  }
};

/** Track which section is visible while scrolling */
const onGridScroll = () => {
  if (isScrollingToCategory) return;
  const container = gridRef.value;
  if (!container) return;
  const containerTop = container.getBoundingClientRect().top;

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sectionRefs.value.length; i++) {
    const el = sectionRefs.value[i];
    if (!el) continue;
    const dist = Math.abs(el.getBoundingClientRect().top - containerTop);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  activeCategoryIndex.value = bestIdx;
};

const setSectionRef = (el: any, idx: number) => {
  if (el) sectionRefs.value[idx] = el as HTMLElement;
};
</script>

<template>
  <Teleport to="body">
    <transition name="emoji-popup">
      <div v-if="props.show" class="fixed inset-0 z-50" @click.self="emit('close')">
        <div
          class="emoji-panel flex flex-col overflow-hidden border border-neutral-grad-0 bg-background-total-theme shadow-2xl"
          :class="isMobile ? 'fixed' : 'absolute rounded-2xl'"
          :style="panelStyle"
        >
          <!-- Main tabs: Emoji | GIF (hidden in reaction mode) -->
          <div v-if="props.mode === 'input'" class="flex shrink-0 border-b border-neutral-grad-0/50 px-2">
            <button
              v-for="tab in (['emoji', 'gif'] as const)"
              :key="tab"
              class="flex-1 py-1.5 text-center text-xs font-medium transition-colors"
              :class="activeTab === tab
                ? 'text-color-bg-ac border-b-2 border-color-bg-ac'
                : 'text-text-on-main-bg-color/60 hover:text-text-on-main-bg-color'"
              @click="activeTab = tab"
            >
              {{ tab === 'emoji' ? '😀' : 'GIF' }}
            </button>
          </div>

          <!-- Search -->
          <div v-if="activeTab === 'emoji'" class="shrink-0 px-3 pt-3 pb-2">
            <div class="relative">
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-grad-2"
              >
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref="searchInputRef"
                v-model="search"
                type="text"
                :placeholder="t('emoji.searchPlaceholder')"
                class="w-full rounded-xl bg-chat-input-bg py-2 pl-9 pr-3 text-sm text-text-color outline-none placeholder:text-neutral-grad-2 focus:ring-2 focus:ring-color-bg-ac/20"
              />
              <button
                v-if="search"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-neutral-grad-2 hover:bg-neutral-grad-0 hover:text-text-color"
                @click="search = ''"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Category tabs (hidden during search) -->
          <div v-if="activeTab === 'emoji' && !search" class="flex shrink-0 gap-0.5 border-b border-neutral-grad-0/50 px-2 pb-1">
            <button
              v-for="(section, i) in allSections"
              :key="section.key"
              class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg transition-all duration-150"
              :class="activeCategoryIndex === i
                ? 'bg-color-bg-ac/12 scale-110'
                : 'hover:bg-neutral-grad-0 opacity-70 hover:opacity-100'"
              :title="section.name"
              @click="scrollToSection(i)"
            >
              {{ section.icon }}
              <div
                v-if="activeCategoryIndex === i"
                class="absolute -bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-color-bg-ac"
              />
            </button>
          </div>

          <!-- Emoji grid — continuous scroll of all categories -->
          <div v-if="activeTab === 'emoji'" ref="gridRef" class="min-h-0 flex-1 overflow-y-auto px-2 py-2" @scroll.passive="onGridScroll">
            <!-- Search results -->
            <template v-if="search">
              <template v-if="filteredEmojis">
                <div class="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-text-on-main-bg-color/60">
                  Results
                </div>
                <div class="grid grid-cols-8 gap-0.5">
                  <button
                    v-for="emoji in filteredEmojis"
                    :key="emoji"
                    class="emoji-btn flex h-10 w-full items-center justify-center rounded-lg text-2xl"
                    @click="handleSelect(emoji)"
                  >
                    {{ emoji }}
                  </button>
                </div>
              </template>

              <!-- No results -->
              <div v-else class="flex h-full flex-col items-center justify-center gap-2 text-text-on-main-bg-color/50">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="opacity-40">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span class="text-sm">No emoji found</span>
              </div>
            </template>

            <!-- All categories in continuous scroll -->
            <template v-else>
              <div
                v-for="(section, i) in allSections"
                :key="section.key"
                :ref="(el) => setSectionRef(el, i)"
              >
                <div class="sticky top-0 z-10 bg-background-total-theme/90 px-1 py-1 text-[11px] font-medium uppercase tracking-wider text-text-on-main-bg-color/60 backdrop-blur-sm">
                  {{ section.name }}
                </div>
                <div class="grid grid-cols-8 gap-0.5 pb-2">
                  <button
                    v-for="emoji in section.emojis"
                    :key="section.key + '-' + emoji"
                    class="emoji-btn flex h-10 w-full items-center justify-center rounded-lg text-2xl"
                    @click="handleSelect(emoji)"
                  >
                    {{ emoji }}
                  </button>
                </div>
              </div>
            </template>
          </div>

          <!-- Emoji Kitchen bar -->
          <EmojiKitchenBar
            v-if="activeTab === 'emoji' && props.mode === 'input'"
            :selected-emoji="lastSelectedEmoji"
            @select="(url: string) => emit('selectKitchen', url)"
          />

          <!-- GIF tab -->
          <GifPicker
            v-if="activeTab === 'gif'"
            class="min-h-0 flex-1"
            @select="(g: TenorGif) => { emit('selectGif', g); emit('close'); }"
          />
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.emoji-popup-enter-active {
  transition: opacity 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
    transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.emoji-popup-leave-active {
  transition: opacity 0.12s ease-in, transform 0.12s ease-in;
}
.emoji-popup-enter-from {
  opacity: 0;
  transform: scale(0.9);
}
.emoji-popup-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

.emoji-btn {
  transition: transform 0.1s ease, background-color 0.15s ease;
  cursor: pointer;
  border-radius: 8px;
}
.emoji-btn:hover {
  background-color: rgba(var(--neutral-grad-0), 0.5);
  transform: scale(1.15);
}
.emoji-btn:active {
  transform: scale(0.95);
}

/* Custom scrollbar for emoji grid */
.emoji-panel ::-webkit-scrollbar {
  width: 6px;
}
.emoji-panel ::-webkit-scrollbar-track {
  background: transparent;
}
.emoji-panel ::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.3);
  border-radius: 3px;
}
.emoji-panel ::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.5);
}
</style>
