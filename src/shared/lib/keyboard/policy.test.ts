import { describe, expect, it } from "vitest";
import { shouldAutofocus, type KeyboardSurface } from "./policy";

function ctx(
  surface: KeyboardSurface,
  flags: { isNative?: boolean; isMobile?: boolean } = {},
) {
  return {
    surface,
    isNative: flags.isNative ?? false,
    isMobile: flags.isMobile ?? false,
  };
}

describe("shouldAutofocus (policy 1A)", () => {
  describe("overlay search on soft-keyboard surfaces", () => {
    const overlays: KeyboardSurface[] = [
      "forward-search",
      "gif-search",
      "chat-search",
      "quick-search",
    ];

    it.each(overlays)("%s is blocked on native", (surface) => {
      expect(shouldAutofocus(ctx(surface, { isNative: true }))).toBe(false);
    });

    it.each(overlays)("%s is blocked on mobile viewport", (surface) => {
      expect(shouldAutofocus(ctx(surface, { isMobile: true }))).toBe(false);
    });

    it.each(overlays)("%s is allowed on desktop web", (surface) => {
      expect(shouldAutofocus(ctx(surface))).toBe(true);
    });
  });

  describe("composer surfaces", () => {
    const composers: KeyboardSurface[] = [
      "composer-edit",
      "composer-reply",
      "composer-forward-caption",
      "composer-emoji-restore",
    ];

    it.each(composers)("%s is allowed on native mobile", (surface) => {
      expect(
        shouldAutofocus(ctx(surface, { isNative: true, isMobile: true })),
      ).toBe(true);
    });

    it.each(composers)("%s is allowed on desktop", (surface) => {
      expect(shouldAutofocus(ctx(surface))).toBe(true);
    });
  });

  it("allows form-field and modal-first-field (caller gates via Modal prop)", () => {
    expect(
      shouldAutofocus(ctx("form-field", { isNative: true, isMobile: true })),
    ).toBe(true);
    expect(
      shouldAutofocus(
        ctx("modal-first-field", { isNative: true, isMobile: true }),
      ),
    ).toBe(true);
  });
});
