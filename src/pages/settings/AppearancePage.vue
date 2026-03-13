<script setup lang="ts">
import MainLayout from "@/widgets/layouts/MainLayout.vue";
import { useThemeStore, Theme } from "@/entities/theme";
import { ACCENT_COLORS, DENSITY_MAP, BUBBLE_RADIUS_MAP, DEFAULT_QUICK_REACTIONS } from "@/entities/theme/model/stores";
import type { FontSize, MessageDensity, BubbleCorners } from "@/entities/theme/model/types";
import { SettingsSection } from "@/shared/ui/settings-section";
import { Toggle } from "@/shared/ui/toggle";
import Modal from "@/shared/ui/modal/Modal.vue";
import EmojiPicker from "@/features/messaging/ui/EmojiPicker.vue";
import { ref } from "vue";

const themeStore = useThemeStore();
const router = useRouter();

// --- Custom accent color ---
const showCustomAccent = ref(false);
const customHex = ref(themeStore.accentColor);

const isValidHex = (h: string) => /^#[0-9A-Fa-f]{6}$/.test(h);
const applyCustomAccent = () => {
  if (isValidHex(customHex.value)) {
    themeStore.setAccentColor(customHex.value);
    showCustomAccent.value = false;
  }
};

// --- Chat background ---
const SOLID_COLORS = [
  { name: "Slate", value: "#64748b" },
  { name: "Stone", value: "#78716c" },
  { name: "Sage", value: "#6b8f71" },
  { name: "Sky", value: "#7dd3fc" },
  { name: "Lavender", value: "#c4b5fd" },
  { name: "Peach", value: "#fda4af" },
  { name: "Sand", value: "#d6d3d1" },
  { name: "Night", value: "#1e293b" },
];

const GRADIENTS = [
  { name: "Ocean", value: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { name: "Sunset", value: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)" },
  { name: "Forest", value: "linear-gradient(135deg, #11998e 0%, #38ef7d 100%)" },
  { name: "Dusk", value: "linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)" },
];

const showCustomWallpaper = ref(false);
const customWallpaperHex = ref("#1e293b");

const applyCustomWallpaper = () => {
  if (isValidHex(customWallpaperHex.value)) {
    themeStore.setChatWallpaper(customWallpaperHex.value);
    showCustomWallpaper.value = false;
  }
};

// --- Font size ---
const FONT_SIZES: { label: string; value: FontSize }[] = [
  { label: "S", value: "small" },
  { label: "M", value: "default" },
  { label: "L", value: "large" },
  { label: "XL", value: "xlarge" },
];

// --- Density ---
const DENSITIES: { label: string; value: MessageDensity }[] = [
  { label: "Compact", value: "compact" },
  { label: "Default", value: "default" },
  { label: "Comfortable", value: "comfortable" },
];

// --- Bubble corners ---
const CORNERS: { label: string; value: BubbleCorners }[] = [
  { label: "Sharp", value: "sharp" },
  { label: "Default", value: "default" },
  { label: "Round", value: "round" },
];

// --- Quick reactions editing ---
const editingQuickReactions = ref(false);
const editingSlotIndex = ref(-1);
const quickReactionPicker = ref({ show: false, x: 0, y: 0 });

const startEditQuickReaction = (index: number, event: MouseEvent) => {
  editingSlotIndex.value = index;
  const btn = (event.currentTarget as HTMLElement).getBoundingClientRect();
  quickReactionPicker.value = { show: true, x: btn.left, y: btn.bottom + 4 };
};

const handleQuickReactionSelect = (emoji: string) => {
  const updated = [...themeStore.quickReactions];
  updated[editingSlotIndex.value] = emoji;
  themeStore.setQuickReactions(updated);
  quickReactionPicker.value.show = false;
};

const resetQuickReactions = () => {
  themeStore.setQuickReactions([...DEFAULT_QUICK_REACTIONS]);
  editingQuickReactions.value = false;
};

// --- Reset confirmation ---
const showResetModal = ref(false);
const confirmReset = () => {
  themeStore.resetToDefaults();
  showResetModal.value = false;
};

// --- Preview helpers (use exported maps from store to avoid duplication) ---
const previewBubbleRadius = computed(() => BUBBLE_RADIUS_MAP[themeStore.bubbleCorners].main);
const previewBubbleRadiusSmall = computed(() => BUBBLE_RADIUS_MAP[themeStore.bubbleCorners].small);
const previewSpacing = computed(() => DENSITY_MAP[themeStore.messageDensity]);
</script>

<template>
  <MainLayout>
    <div class="flex h-full flex-col">
      <!-- Header -->
      <div class="flex items-center gap-3 border-b border-neutral-grad-0 px-4 py-3">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="router.back()"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 class="text-lg font-bold text-text-color">Appearance</h1>
      </div>

      <!-- Scrollable content -->
      <div class="flex-1 overflow-y-auto">
        <!-- Live Chat Preview (sticky) -->
        <div class="sticky top-0 z-10 border-b border-neutral-grad-0 bg-background-total-theme p-4">
          <div
            class="overflow-hidden rounded-xl border border-neutral-grad-0"
            :style="{ background: themeStore.chatWallpaper || undefined }"
          >
            <!-- Preview header -->
            <div class="flex items-center gap-2 border-b border-neutral-grad-0 bg-background-total-theme px-3 py-2">
              <div class="h-7 w-7 rounded-full bg-color-bg-ac/20 flex items-center justify-center">
                <span class="text-xs font-bold text-color-bg-ac">A</span>
              </div>
              <div>
                <div class="text-sm font-medium text-text-color">Alice</div>
                <div class="text-[10px] text-text-on-main-bg-color">chat</div>
              </div>
            </div>
            <!-- Preview messages -->
            <div class="flex flex-col p-3" :style="{ gap: previewSpacing }">
              <!-- Other's message -->
              <div class="flex justify-start">
                <div
                  v-if="themeStore.showAvatarsInChat"
                  class="mr-1.5 mt-auto h-6 w-6 shrink-0 rounded-full bg-color-bg-ac/20 flex items-center justify-center"
                >
                  <span class="text-[9px] font-bold text-color-bg-ac">A</span>
                </div>
                <div
                  class="max-w-[70%] bg-chat-bubble-other px-3 py-1.5 text-text-color"
                  :style="{
                    fontSize: 'var(--font-size-base)',
                    borderRadius: previewBubbleRadius,
                    borderBottomLeftRadius: previewBubbleRadiusSmall,
                  }"
                >
                  Hey! How are you doing? 🎉
                  <span v-if="themeStore.showTimestamps" class="ml-1 inline-flex items-center text-[10px] text-text-on-main-bg-color">10:24</span>
                </div>
              </div>
              <!-- Own message -->
              <div class="flex justify-end">
                <div
                  class="max-w-[70%] bg-chat-bubble-own px-3 py-1.5 text-text-on-bg-ac-color"
                  :style="{
                    fontSize: 'var(--font-size-base)',
                    borderRadius: previewBubbleRadius,
                    borderBottomRightRadius: previewBubbleRadiusSmall,
                  }"
                >
                  I'm great, thanks!
                  <span v-if="themeStore.showTimestamps" class="ml-1 inline-flex items-center text-[10px] text-white/60">10:25 ✓✓</span>
                </div>
              </div>
              <!-- Reply message -->
              <div class="flex justify-start">
                <div v-if="themeStore.showAvatarsInChat" class="mr-1.5 w-6 shrink-0" />
                <div
                  class="max-w-[70%] bg-chat-bubble-other px-3 py-1.5 text-text-color"
                  :style="{
                    fontSize: 'var(--font-size-base)',
                    borderRadius: previewBubbleRadius,
                  }"
                >
                  <div class="mb-1 flex items-start gap-1.5 rounded-lg bg-black/5 px-2 py-1">
                    <div class="w-0.5 shrink-0 self-stretch rounded-full bg-color-bg-ac" />
                    <div class="min-w-0">
                      <div class="text-[10px] font-medium text-color-bg-ac">You</div>
                      <div class="truncate text-[10px] opacity-70">I'm great, thanks!</div>
                    </div>
                  </div>
                  Let's meet up! 🎬
                  <span v-if="themeStore.showTimestamps" class="ml-1 inline-flex items-center text-[10px] text-text-on-main-bg-color">10:26</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Settings sections -->
        <div class="space-y-6 p-4">

          <!-- Section 1: Theme -->
          <SettingsSection title="Theme">
            <div class="flex gap-3">
              <button
                class="flex flex-1 flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all"
                :class="!themeStore.isDarkMode ? 'border-color-bg-ac bg-color-bg-ac/5' : 'border-neutral-grad-0 hover:border-neutral-grad-2'"
                @click="themeStore.setTheme(Theme.light)"
              >
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  </svg>
                </div>
                <span class="text-sm font-medium text-text-color">Light</span>
              </button>
              <button
                class="flex flex-1 flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all"
                :class="themeStore.isDarkMode ? 'border-color-bg-ac bg-color-bg-ac/5' : 'border-neutral-grad-0 hover:border-neutral-grad-2'"
                @click="themeStore.setTheme(Theme.dark)"
              >
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 shadow">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="2">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                </div>
                <span class="text-sm font-medium text-text-color">Dark</span>
              </button>
            </div>
          </SettingsSection>

          <!-- Section 2: Accent Color -->
          <SettingsSection title="Accent Color">
            <div class="flex flex-wrap gap-3">
              <button
                v-for="color in ACCENT_COLORS"
                :key="color.value"
                class="flex flex-col items-center gap-1.5"
                @click="themeStore.setAccentColor(color.value)"
              >
                <div
                  class="flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all"
                  :class="themeStore.accentColor === color.value ? 'border-text-color scale-110' : 'border-transparent'"
                  :style="{ backgroundColor: color.value }"
                >
                  <svg
                    v-if="themeStore.accentColor === color.value"
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ color.name }}</span>
              </button>
              <!-- Custom color button -->
              <button
                class="flex flex-col items-center gap-1.5"
                @click="showCustomAccent = true; customHex = themeStore.accentColor"
              >
                <div
                  class="flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all"
                  :class="!ACCENT_COLORS.some(c => c.value === themeStore.accentColor) ? 'border-text-color scale-110' : 'border-neutral-grad-0'"
                  :style="!ACCENT_COLORS.some(c => c.value === themeStore.accentColor) ? { backgroundColor: themeStore.accentColor } : {}"
                >
                  <svg
                    v-if="ACCENT_COLORS.some(c => c.value === themeStore.accentColor)"
                    width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <svg
                    v-else
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">Custom</span>
              </button>
            </div>
            <!-- Custom hex input (inline) -->
            <div v-if="showCustomAccent" class="mt-3 flex items-center gap-2">
              <div
                class="h-8 w-8 shrink-0 rounded-full border border-neutral-grad-0"
                :style="{ backgroundColor: isValidHex(customHex) ? customHex : '#ccc' }"
              />
              <input
                v-model="customHex"
                type="text"
                maxlength="7"
                placeholder="#3B82F6"
                class="h-9 flex-1 rounded-lg border border-neutral-grad-0 bg-background-secondary-theme px-3 text-sm text-text-color outline-none focus:border-color-bg-ac"
              />
              <button
                class="h-9 rounded-lg bg-color-bg-ac px-4 text-sm font-medium text-text-on-bg-ac-color transition-colors disabled:opacity-50"
                :disabled="!isValidHex(customHex)"
                @click="applyCustomAccent"
              >
                Apply
              </button>
              <button
                class="h-9 rounded-lg px-3 text-sm text-text-on-main-bg-color hover:bg-neutral-grad-0"
                @click="showCustomAccent = false"
              >
                Cancel
              </button>
            </div>
          </SettingsSection>

          <!-- Section 3: Chat Background -->
          <SettingsSection title="Chat Background" description="Customize the chat area background">
            <div class="flex flex-wrap gap-2">
              <!-- Default -->
              <button
                class="flex h-10 w-10 items-center justify-center rounded-lg border-2 transition-all"
                :class="!themeStore.chatWallpaper ? 'border-color-bg-ac' : 'border-neutral-grad-0'"
                @click="themeStore.setChatWallpaper('')"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                  <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
              </button>
              <!-- Solid colors -->
              <button
                v-for="color in SOLID_COLORS"
                :key="color.value"
                class="h-10 w-10 rounded-lg border-2 transition-all"
                :class="themeStore.chatWallpaper === color.value ? 'border-color-bg-ac scale-110' : 'border-transparent'"
                :style="{ backgroundColor: color.value }"
                :title="color.name"
                @click="themeStore.setChatWallpaper(color.value)"
              />
              <!-- Custom wallpaper color -->
              <button
                class="flex h-10 w-10 items-center justify-center rounded-lg border-2 transition-all"
                :class="showCustomWallpaper ? 'border-color-bg-ac' : 'border-neutral-grad-0'"
                @click="showCustomWallpaper = !showCustomWallpaper"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
            <!-- Gradients -->
            <div class="mt-2 flex flex-wrap gap-2">
              <button
                v-for="grad in GRADIENTS"
                :key="grad.value"
                class="h-10 w-16 rounded-lg border-2 transition-all"
                :class="themeStore.chatWallpaper === grad.value ? 'border-color-bg-ac scale-105' : 'border-transparent'"
                :style="{ background: grad.value }"
                :title="grad.name"
                @click="themeStore.setChatWallpaper(grad.value)"
              />
            </div>
            <!-- Custom wallpaper hex input -->
            <div v-if="showCustomWallpaper" class="mt-2 flex items-center gap-2">
              <div
                class="h-8 w-8 shrink-0 rounded-lg border border-neutral-grad-0"
                :style="{ backgroundColor: isValidHex(customWallpaperHex) ? customWallpaperHex : '#ccc' }"
              />
              <input
                v-model="customWallpaperHex"
                type="text"
                maxlength="7"
                placeholder="#1e293b"
                class="h-9 flex-1 rounded-lg border border-neutral-grad-0 bg-background-secondary-theme px-3 text-sm text-text-color outline-none focus:border-color-bg-ac"
              />
              <button
                class="h-9 rounded-lg bg-color-bg-ac px-4 text-sm font-medium text-text-on-bg-ac-color transition-colors disabled:opacity-50"
                :disabled="!isValidHex(customWallpaperHex)"
                @click="applyCustomWallpaper"
              >
                Apply
              </button>
            </div>
          </SettingsSection>

          <!-- Section 4: Font Size -->
          <SettingsSection title="Font Size">
            <div class="flex rounded-lg bg-background-secondary-theme p-1">
              <button
                v-for="fs in FONT_SIZES"
                :key="fs.value"
                class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-all"
                :class="themeStore.fontSize === fs.value ? 'bg-color-bg-ac text-text-on-bg-ac-color shadow-sm' : 'text-text-on-main-bg-color hover:text-text-color'"
                @click="themeStore.setFontSize(fs.value)"
              >
                {{ fs.label }}
              </button>
            </div>
            <p class="mt-1 text-text-on-main-bg-color" :style="{ fontSize: 'var(--font-size-base)' }">
              Preview text at current size
            </p>
          </SettingsSection>

          <!-- Section 5: Message Density -->
          <SettingsSection title="Message Density" description="Control spacing between messages">
            <div class="flex rounded-lg bg-background-secondary-theme p-1">
              <button
                v-for="d in DENSITIES"
                :key="d.value"
                class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-all"
                :class="themeStore.messageDensity === d.value ? 'bg-color-bg-ac text-text-on-bg-ac-color shadow-sm' : 'text-text-on-main-bg-color hover:text-text-color'"
                @click="themeStore.setMessageDensity(d.value)"
              >
                {{ d.label }}
              </button>
            </div>
          </SettingsSection>

          <!-- Section 6: Bubble Corners -->
          <SettingsSection title="Bubble Corners">
            <div class="flex rounded-lg bg-background-secondary-theme p-1">
              <button
                v-for="c in CORNERS"
                :key="c.value"
                class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-all"
                :class="themeStore.bubbleCorners === c.value ? 'bg-color-bg-ac text-text-on-bg-ac-color shadow-sm' : 'text-text-on-main-bg-color hover:text-text-color'"
                @click="themeStore.setBubbleCorners(c.value)"
              >
                {{ c.label }}
              </button>
            </div>
          </SettingsSection>

          <!-- Section 7: Toggle settings -->
          <SettingsSection title="Chat Options">
            <div class="space-y-1">
              <!-- Show avatars -->
              <div class="flex items-center justify-between rounded-lg p-3">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                  </svg>
                  <span class="text-sm text-text-color">Show avatars in chats</span>
                </div>
                <Toggle
                  :model-value="themeStore.showAvatarsInChat"
                  @update:model-value="themeStore.setShowAvatarsInChat"
                />
              </div>
              <!-- Show timestamps -->
              <div class="flex items-center justify-between rounded-lg p-3">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span class="text-sm text-text-color">Show timestamps</span>
                </div>
                <Toggle
                  :model-value="themeStore.showTimestamps"
                  @update:model-value="themeStore.setShowTimestamps"
                />
              </div>
              <!-- Group consecutive messages -->
              <div class="flex items-center justify-between rounded-lg p-3">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                  </svg>
                  <span class="text-sm text-text-color">Group consecutive messages</span>
                </div>
                <Toggle
                  :model-value="themeStore.messageGrouping"
                  @update:model-value="themeStore.setMessageGrouping"
                />
              </div>
              <!-- Enable animations -->
              <div class="flex items-center justify-between rounded-lg p-3">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <span class="text-sm text-text-color">Enable animations</span>
                </div>
                <Toggle
                  :model-value="themeStore.animationsEnabled"
                  @update:model-value="themeStore.setAnimationsEnabled"
                />
              </div>
              <!-- Animated reactions -->
              <div class="flex items-center justify-between rounded-lg p-3">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                  <span class="text-sm text-text-color">Animated Reactions</span>
                </div>
                <Toggle
                  :model-value="themeStore.animatedReactions"
                  @update:model-value="themeStore.setAnimatedReactions"
                />
              </div>
            </div>
          </SettingsSection>

          <!-- Section 8: Quick Reactions -->
          <SettingsSection title="Quick Reactions" description="Customize the emoji shortcuts shown in the context menu">
            <div class="flex items-center gap-2">
              <div class="flex gap-1.5">
                <button
                  v-for="(emoji, i) in themeStore.quickReactions"
                  :key="i"
                  class="flex h-10 w-10 items-center justify-center rounded-lg text-xl transition-all"
                  :class="editingQuickReactions ? 'border-2 border-dashed border-color-bg-ac/40 hover:border-color-bg-ac hover:bg-color-bg-ac/5' : 'border border-neutral-grad-0'"
                  @click="editingQuickReactions ? startEditQuickReaction(i, $event) : undefined"
                >
                  {{ emoji }}
                </button>
              </div>
              <button
                v-if="!editingQuickReactions"
                class="ml-auto rounded-lg px-3 py-1.5 text-sm font-medium text-color-bg-ac transition-colors hover:bg-color-bg-ac/5"
                @click="editingQuickReactions = true"
              >
                Edit
              </button>
              <div v-else class="ml-auto flex gap-2">
                <button
                  class="rounded-lg px-3 py-1.5 text-xs text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
                  @click="resetQuickReactions"
                >
                  Reset
                </button>
                <button
                  class="rounded-lg bg-color-bg-ac px-3 py-1.5 text-xs font-medium text-text-on-bg-ac-color transition-colors"
                  @click="editingQuickReactions = false"
                >
                  Done
                </button>
              </div>
            </div>
            <p v-if="editingQuickReactions" class="mt-1.5 text-xs text-text-on-main-bg-color">
              Tap an emoji to replace it
            </p>
          </SettingsSection>

          <EmojiPicker
            :show="quickReactionPicker.show"
            :x="quickReactionPicker.x"
            :y="quickReactionPicker.y"
            mode="reaction"
            @close="quickReactionPicker.show = false"
            @select="handleQuickReactionSelect"
          />

          <!-- Section 9: Reset to Defaults -->
          <div class="pb-8">
            <button
              class="w-full rounded-lg border border-color-bad/30 px-4 py-3 text-sm font-medium text-color-bad transition-colors hover:bg-color-bad/5"
              @click="showResetModal = true"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>

      <!-- Reset confirmation modal -->
      <Modal :show="showResetModal" @close="showResetModal = false">
        <div class="p-5">
          <h3 class="mb-2 text-base font-semibold text-text-color">Reset Appearance?</h3>
          <p class="mb-4 text-sm text-text-on-main-bg-color">
            This will reset all appearance settings to their default values.
          </p>
          <div class="flex gap-2">
            <button
              class="flex-1 rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
              @click="confirmReset"
            >
              Reset
            </button>
            <button
              class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
              @click="showResetModal = false"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  </MainLayout>
</template>
