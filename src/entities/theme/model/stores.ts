import { isSystemDarkMode, setThemeHtml } from "@/entities/theme/lib";
import { Theme } from "@/entities/theme/model/types";
import type { FontSize, MessageDensity, BubbleCorners } from "@/entities/theme/model/types";
import { useLocalStorage } from "@/shared/lib/browser";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

const NAMESPACE = "theme";

export const DEFAULT_QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

const ACCENT_COLORS = [
  { name: "Blue", value: "#3B82F6" },
  { name: "Purple", value: "#8B5CF6" },
  { name: "Green", value: "#10B981" },
  { name: "Orange", value: "#F59E0B" },
  { name: "Pink", value: "#EC4899" },
  { name: "Red", value: "#EF4444" },
  { name: "Teal", value: "#14B8A6" },
] as const;

export { ACCENT_COLORS };

export const FONT_SIZE_MAP: Record<FontSize, string> = {
  small: "14px",
  default: "16px",
  large: "18px",
  xlarge: "20px",
};

export const DENSITY_MAP: Record<MessageDensity, string> = {
  compact: "2px",
  default: "8px",
  comfortable: "14px",
};

export const BUBBLE_RADIUS_MAP: Record<BubbleCorners, { main: string; small: string }> = {
  sharp: { main: "4px", small: "2px" },
  default: { main: "16px", small: "4px" },
  round: { main: "24px", small: "8px" },
};

export const useThemeStore = defineStore(NAMESPACE, () => {
  // --- Core theme & accent ---
  const { setLSValue: setLSTheme, value: lsTheme } =
    useLocalStorage<Theme>(NAMESPACE);

  const { setLSValue: setLSAccent, value: lsAccent } =
    useLocalStorage<string>("accent_color");

  const theme = ref(lsTheme);
  const accentColor = ref(lsAccent || ACCENT_COLORS[0].value);

  const isDarkMode = computed(
    () => theme.value === Theme.dark || (!theme.value && isSystemDarkMode())
  );

  const setTheme = (_theme: Theme) => {
    theme.value = _theme;
    setThemeHtml(_theme);
    setLSTheme(_theme);
  };

  const toggleTheme = () => {
    setTheme(isDarkMode.value ? Theme.light : Theme.dark);
  };

  const setAccentColor = (color: string) => {
    accentColor.value = color;
    setLSAccent(color);
    applyAccentColor(color);
  };

  const applyAccentColor = (color: string) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const rgb = `${r} ${g} ${b}`;
    document.documentElement.style.setProperty("--color-bg-ac", rgb);
    document.documentElement.style.setProperty("--color-bg-ac-rgb", rgb);
    document.documentElement.style.setProperty("--chat-bubble-own", rgb);
  };

  // --- Font size ---
  const { setLSValue: setLSFontSize, value: lsFontSize } =
    useLocalStorage<FontSize>("font_size");
  const fontSize = ref<FontSize>(lsFontSize || "default");

  const setFontSize = (size: FontSize) => {
    fontSize.value = size;
    setLSFontSize(size);
    applyCSSVar("--font-size-base", FONT_SIZE_MAP[size]);
  };

  // --- Message density ---
  const { setLSValue: setLSDensity, value: lsDensity } =
    useLocalStorage<MessageDensity>("message_density");
  const messageDensity = ref<MessageDensity>(lsDensity || "default");

  const setMessageDensity = (density: MessageDensity) => {
    messageDensity.value = density;
    setLSDensity(density);
    applyCSSVar("--message-spacing", DENSITY_MAP[density]);
  };

  // --- Bubble corners ---
  const { setLSValue: setLSBubbleCorners, value: lsBubbleCorners } =
    useLocalStorage<BubbleCorners>("bubble_corners");
  const bubbleCorners = ref<BubbleCorners>(lsBubbleCorners || "default");

  const setBubbleCorners = (corners: BubbleCorners) => {
    bubbleCorners.value = corners;
    setLSBubbleCorners(corners);
    const radii = BUBBLE_RADIUS_MAP[corners];
    applyCSSVar("--bubble-radius", radii.main);
    applyCSSVar("--bubble-radius-small", radii.small);
  };

  // --- Show avatars ---
  const { setLSValue: setLSShowAvatars, value: lsShowAvatars } =
    useLocalStorage<boolean>("show_avatars");
  const showAvatarsInChat = ref(lsShowAvatars ?? true);

  const setShowAvatarsInChat = (v: boolean) => {
    showAvatarsInChat.value = v;
    setLSShowAvatars(v);
  };

  // --- Animations ---
  const { setLSValue: setLSAnimations, value: lsAnimations } =
    useLocalStorage<boolean>("animations");
  const animationsEnabled = ref(lsAnimations ?? true);

  const setAnimationsEnabled = (v: boolean) => {
    animationsEnabled.value = v;
    setLSAnimations(v);
    document.documentElement.setAttribute("data-animations", String(v));
  };

  // --- Chat wallpaper ---
  const { setLSValue: setLSWallpaper, value: lsWallpaper } =
    useLocalStorage<string>("chat_wallpaper");
  const chatWallpaper = ref(lsWallpaper || "");

  const setChatWallpaper = (value: string) => {
    chatWallpaper.value = value;
    setLSWallpaper(value);
  };

  // --- Show timestamps ---
  const { setLSValue: setLSTimestamps, value: lsTimestamps } =
    useLocalStorage<boolean>("show_timestamps");
  const showTimestamps = ref(lsTimestamps ?? true);

  const setShowTimestamps = (v: boolean) => {
    showTimestamps.value = v;
    setLSTimestamps(v);
  };

  // --- Message grouping ---
  const { setLSValue: setLSGrouping, value: lsGrouping } =
    useLocalStorage<boolean>("message_grouping");
  const messageGrouping = ref(lsGrouping ?? true);

  const setMessageGrouping = (v: boolean) => {
    messageGrouping.value = v;
    setLSGrouping(v);
  };

  // --- Quick reactions ---
  const { setLSValue: setLSQuickReactions, value: lsQuickReactions } =
    useLocalStorage<string[]>("quick_reactions");
  const quickReactions = ref<string[]>(lsQuickReactions || [...DEFAULT_QUICK_REACTIONS]);

  const setQuickReactions = (emojis: string[]) => {
    quickReactions.value = emojis;
    setLSQuickReactions(emojis);
  };

  // --- Recent emojis ---
  const { setLSValue: setLSRecentEmojis, value: lsRecentEmojis } =
    useLocalStorage<string[]>("recent_emojis");
  const recentEmojis = ref<string[]>(lsRecentEmojis || []);

  const addRecentEmoji = (emoji: string) => {
    const filtered = recentEmojis.value.filter(e => e !== emoji);
    recentEmojis.value = [emoji, ...filtered].slice(0, 24);
    setLSRecentEmojis(recentEmojis.value);
  };

  // --- CSS var helper ---
  const applyCSSVar = (name: string, value: string) => {
    document.documentElement.style.setProperty(name, value);
  };

  // --- Apply all settings to CSS vars ---
  const applyAllSettings = () => {
    applyCSSVar("--font-size-base", FONT_SIZE_MAP[fontSize.value]);
    applyCSSVar("--message-spacing", DENSITY_MAP[messageDensity.value]);
    const radii = BUBBLE_RADIUS_MAP[bubbleCorners.value];
    applyCSSVar("--bubble-radius", radii.main);
    applyCSSVar("--bubble-radius-small", radii.small);
  };

  // --- Reset to defaults ---
  const resetToDefaults = () => {
    setTheme(isSystemDarkMode() ? Theme.dark : Theme.light);
    setAccentColor(ACCENT_COLORS[0].value);
    setFontSize("default");
    setMessageDensity("default");
    setBubbleCorners("default");
    setShowAvatarsInChat(true);
    setAnimationsEnabled(true);
    setChatWallpaper("");
    setShowTimestamps(true);
    setMessageGrouping(true);
    setQuickReactions([...DEFAULT_QUICK_REACTIONS]);
    recentEmojis.value = [];
    setLSRecentEmojis([]);
  };

  // --- Init ---
  const initTheme = () => {
    setTheme(isDarkMode.value ? Theme.dark : Theme.light);
    if (accentColor.value) applyAccentColor(accentColor.value);
    applyAllSettings();
    document.documentElement.setAttribute("data-animations", String(animationsEnabled.value));
  };

  return {
    // Core
    accentColor,
    initTheme,
    isDarkMode,
    setAccentColor,
    setTheme,
    theme,
    toggleTheme,
    // New settings
    fontSize,
    setFontSize,
    messageDensity,
    setMessageDensity,
    bubbleCorners,
    setBubbleCorners,
    showAvatarsInChat,
    setShowAvatarsInChat,
    animationsEnabled,
    setAnimationsEnabled,
    chatWallpaper,
    setChatWallpaper,
    showTimestamps,
    setShowTimestamps,
    messageGrouping,
    setMessageGrouping,
    quickReactions,
    setQuickReactions,
    recentEmojis,
    addRecentEmoji,
    resetToDefaults,
  };
});
