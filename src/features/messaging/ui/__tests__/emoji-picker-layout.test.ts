import { describe, it, expect } from "vitest";
import {
  computePanelStyle,
  computeMobileInputPanelStyle,
  computeMobileReactionPanelStyle,
  computeAnchoredPanelStyle,
  PICKER_PAD,
  PICKER_GAP,
} from "../emoji-picker-layout";

describe("emoji-picker-layout", () => {
  describe("mobile input mode", () => {
    it("docks above MessageInput via --message-input-height", () => {
      const style = computeMobileInputPanelStyle();
      expect(style.bottom).toBe("var(--message-input-height, 0px)");
      expect(style.top).toBe("auto");
      expect(style.width).toBe("100%");
      expect(style.left).toBe("0px");
      expect(style.borderRadius).toBe("16px 16px 0 0");
    });

    it("computePanelStyle delegates to mobile-input branch when isMobile + mode=input", () => {
      const style = computePanelStyle({ isMobile: true, mode: "input", x: 0, y: 0, vw: 360, vh: 800 });
      expect(style.bottom).toBe("var(--message-input-height, 0px)");
      expect(style.top).toBe("auto");
    });
  });

  describe("mobile reaction mode", () => {
    it("places the picker above the tap point (with a gap) when there's room", () => {
      const y = 700;
      const style = computeMobileReactionPanelStyle(y, 800);
      const top = parseInt(style.top, 10);
      const panelH = parseInt(style.height, 10);
      expect(Number.isNaN(top)).toBe(false);
      // Panel sits fully above the tap point, clearing it by at least the gap.
      expect(top + panelH).toBeLessThanOrEqual(y - PICKER_GAP);
      expect(top).toBeGreaterThanOrEqual(PICKER_PAD);
      expect(style.bottom).toBe("auto");
      expect(style.width).toBe("100%");
    });

    it("drops below the tap point (not covering the message) when there's no room above", () => {
      const vh = 800;
      const y = 40;
      const style = computeMobileReactionPanelStyle(y, vh);
      const top = parseInt(style.top, 10);
      const panelH = parseInt(style.height, 10);
      // No room above (y=40) → place below the tap point with a gap, never on it.
      expect(top).toBeGreaterThanOrEqual(y + PICKER_GAP);
      expect(top + panelH).toBeLessThanOrEqual(vh);
    });

    it("clamps top to PICKER_PAD when the viewport is shorter than the panel", () => {
      // Tiny viewport: vh=300, panelH = min(360, 150) = 150, y=10
      // The fallback branch lands at vh - panelH - PAD = 300 - 150 - 8 = 142.
      // Verify the lower-bound clamp still holds.
      const style = computeMobileReactionPanelStyle(10, 300);
      const top = parseInt(style.top, 10);
      expect(top).toBeGreaterThanOrEqual(PICKER_PAD);
    });

    it("avoids the tap point across a range of press positions on a normal viewport (forta-bugs#791)", () => {
      const vh = 800;
      for (const y of [80, 200, 400, 600, 720]) {
        const style = computeMobileReactionPanelStyle(y, vh);
        const top = parseInt(style.top, 10);
        const panelH = parseInt(style.height, 10);
        const coversTap = y >= top && y <= top + panelH;
        expect(coversTap).toBe(false);
      }
    });

    it("stays on-screen even on a short viewport where the panel can't fully clear the tap", () => {
      // vh=480 → panelH = min(360, 240) = 240, which is half the viewport, so a
      // mid-screen tap can't be cleared on either side. The clamp must still
      // keep the panel fully within the viewport (best-effort placement).
      const vh = 480;
      for (const y of [60, 240, 420]) {
        const style = computeMobileReactionPanelStyle(y, vh);
        const top = parseInt(style.top, 10);
        const panelH = parseInt(style.height, 10);
        expect(top).toBeGreaterThanOrEqual(PICKER_PAD);
        expect(top + panelH).toBeLessThanOrEqual(vh);
      }
    });

    it("computePanelStyle uses props.y on mobile + reaction mode (regression: do not pin to bottom: 0)", () => {
      const style = computePanelStyle({ isMobile: true, mode: "reaction", x: 100, y: 700, vw: 360, vh: 800 });
      const top = parseInt(style.top, 10);
      expect(top).toBeLessThan(700);
      expect(top).toBeGreaterThan(0);
      expect(style.bottom).toBe("auto");
    });
  });

  describe("desktop / tablet", () => {
    it("places the picker above the click when there's room", () => {
      const style = computeAnchoredPanelStyle(400, 600, 1280, 800);
      const top = parseInt(style.top, 10);
      expect(top).toBeLessThan(600);
      expect(top).toBeGreaterThanOrEqual(PICKER_PAD);
    });

    it("clamps to viewport when the click is too close to the right edge", () => {
      const vw = 1024;
      const style = computeAnchoredPanelStyle(vw - 10, 400, vw, 800);
      const left = parseInt(style.left, 10);
      const width = parseInt(style.width, 10);
      expect(left + width).toBeLessThanOrEqual(vw - PICKER_PAD);
    });

    it("computePanelStyle returns a desktop layout when isMobile=false", () => {
      const style = computePanelStyle({ isMobile: false, mode: "input", x: 100, y: 200, vw: 1280, vh: 800 });
      expect(style.width).not.toBe("100%");
      expect(style.bottom).toBe("auto");
    });
  });
});
