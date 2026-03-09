import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

// Mock theme lib functions before importing the store
vi.mock("@/entities/theme/lib", () => ({
  isSystemDarkMode: vi.fn(() => false),
  setThemeHtml: vi.fn(),
}));

import { useThemeStore, FONT_SIZE_MAP, DENSITY_MAP, BUBBLE_RADIUS_MAP, ACCENT_COLORS, DEFAULT_QUICK_REACTIONS } from "./stores";
import { Theme } from "./types";

describe("theme-store", () => {
  let store: ReturnType<typeof useThemeStore>;

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useThemeStore();
  });

  // ─── setTheme / toggleTheme ───────────────────────────────────

  describe("setTheme / toggleTheme", () => {
    it("sets theme to dark", () => {
      store.setTheme(Theme.dark);
      expect(store.theme).toBe(Theme.dark);
    });

    it("sets theme to light", () => {
      store.setTheme(Theme.light);
      expect(store.theme).toBe(Theme.light);
    });

    it("toggleTheme switches from dark to light", () => {
      store.setTheme(Theme.dark);
      store.toggleTheme();
      expect(store.theme).toBe(Theme.light);
    });

    it("toggleTheme switches from light to dark", () => {
      store.setTheme(Theme.light);
      store.toggleTheme();
      expect(store.theme).toBe(Theme.dark);
    });
  });

  // ─── setFontSize ──────────────────────────────────────────────

  describe("setFontSize", () => {
    it("updates fontSize state", () => {
      store.setFontSize("large");
      expect(store.fontSize).toBe("large");
    });

    it("applies CSS variable", () => {
      store.setFontSize("xlarge");
      const cssVal = document.documentElement.style.getPropertyValue("--font-size-base");
      expect(cssVal).toBe(FONT_SIZE_MAP["xlarge"]);
    });
  });

  // ─── setMessageDensity ────────────────────────────────────────

  describe("setMessageDensity", () => {
    it("updates messageDensity state", () => {
      store.setMessageDensity("compact");
      expect(store.messageDensity).toBe("compact");
    });

    it("applies CSS variable", () => {
      store.setMessageDensity("comfortable");
      const cssVal = document.documentElement.style.getPropertyValue("--message-spacing");
      expect(cssVal).toBe(DENSITY_MAP["comfortable"]);
    });
  });

  // ─── setBubbleCorners ─────────────────────────────────────────

  describe("setBubbleCorners", () => {
    it("updates bubbleCorners state", () => {
      store.setBubbleCorners("round");
      expect(store.bubbleCorners).toBe("round");
    });

    it("applies both CSS variables", () => {
      store.setBubbleCorners("sharp");
      expect(document.documentElement.style.getPropertyValue("--bubble-radius")).toBe(BUBBLE_RADIUS_MAP["sharp"].main);
      expect(document.documentElement.style.getPropertyValue("--bubble-radius-small")).toBe(BUBBLE_RADIUS_MAP["sharp"].small);
    });
  });

  // ─── addRecentEmoji ───────────────────────────────────────────

  describe("addRecentEmoji", () => {
    it("adds emoji to front of list", () => {
      store.addRecentEmoji("🎉");
      expect(store.recentEmojis[0]).toBe("🎉");
    });

    it("deduplicates — moves existing emoji to front", () => {
      store.addRecentEmoji("😀");
      store.addRecentEmoji("🎉");
      store.addRecentEmoji("😀"); // already exists
      expect(store.recentEmojis[0]).toBe("😀");
      expect(store.recentEmojis).toHaveLength(2);
    });

    it("caps at 24 emojis", () => {
      const emojis = "😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙🥲😚☺️😌😛😝😜🤪".split("");
      // Some of those are multi-codepoint, but let's add 30 unique ones
      for (let i = 0; i < 30; i++) {
        store.addRecentEmoji(`emoji_${i}`);
      }
      expect(store.recentEmojis.length).toBeLessThanOrEqual(24);
    });

    it("most recent emoji is always first", () => {
      store.addRecentEmoji("A");
      store.addRecentEmoji("B");
      store.addRecentEmoji("C");
      expect(store.recentEmojis[0]).toBe("C");
    });
  });

  // ─── resetToDefaults ──────────────────────────────────────────

  describe("resetToDefaults", () => {
    it("resets fontSize to default", () => {
      store.setFontSize("xlarge");
      store.resetToDefaults();
      expect(store.fontSize).toBe("default");
    });

    it("resets messageDensity to default", () => {
      store.setMessageDensity("compact");
      store.resetToDefaults();
      expect(store.messageDensity).toBe("default");
    });

    it("resets bubbleCorners to default", () => {
      store.setBubbleCorners("sharp");
      store.resetToDefaults();
      expect(store.bubbleCorners).toBe("default");
    });

    it("resets quickReactions to defaults", () => {
      store.setQuickReactions(["👍"]);
      store.resetToDefaults();
      expect(store.quickReactions).toEqual(DEFAULT_QUICK_REACTIONS);
    });

    it("clears recentEmojis", () => {
      store.addRecentEmoji("🎉");
      store.resetToDefaults();
      expect(store.recentEmojis).toEqual([]);
    });

    it("resets accent color to first option", () => {
      store.setAccentColor("#FF0000");
      store.resetToDefaults();
      expect(store.accentColor).toBe(ACCENT_COLORS[0].value);
    });
  });

  // ─── Constants validation ─────────────────────────────────────

  describe("constants", () => {
    it("FONT_SIZE_MAP has all four sizes", () => {
      expect(Object.keys(FONT_SIZE_MAP)).toEqual(["small", "default", "large", "xlarge"]);
    });

    it("DENSITY_MAP has all three densities", () => {
      expect(Object.keys(DENSITY_MAP)).toEqual(["compact", "default", "comfortable"]);
    });

    it("BUBBLE_RADIUS_MAP has all three options with main and small", () => {
      for (const key of ["sharp", "default", "round"] as const) {
        expect(BUBBLE_RADIUS_MAP[key]).toHaveProperty("main");
        expect(BUBBLE_RADIUS_MAP[key]).toHaveProperty("small");
      }
    });

    it("ACCENT_COLORS has at least 5 options", () => {
      expect(ACCENT_COLORS.length).toBeGreaterThanOrEqual(5);
    });

    it("DEFAULT_QUICK_REACTIONS has 6 emojis", () => {
      expect(DEFAULT_QUICK_REACTIONS).toHaveLength(6);
    });
  });

  // ─── Boolean settings ─────────────────────────────────────────

  describe("boolean settings", () => {
    it("setShowAvatarsInChat toggles value", () => {
      store.setShowAvatarsInChat(false);
      expect(store.showAvatarsInChat).toBe(false);
      store.setShowAvatarsInChat(true);
      expect(store.showAvatarsInChat).toBe(true);
    });

    it("setAnimationsEnabled toggles value", () => {
      store.setAnimationsEnabled(false);
      expect(store.animationsEnabled).toBe(false);
    });

    it("setShowTimestamps toggles value", () => {
      store.setShowTimestamps(false);
      expect(store.showTimestamps).toBe(false);
    });

    it("setMessageGrouping toggles value", () => {
      store.setMessageGrouping(false);
      expect(store.messageGrouping).toBe(false);
    });
  });
});
