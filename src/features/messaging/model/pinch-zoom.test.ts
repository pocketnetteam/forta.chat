import { describe, it, expect } from "vitest";
import { touchDistance, nextScale, MIN_SCALE, MAX_SCALE } from "./pinch-zoom";

describe("pinch-zoom math", () => {
  describe("touchDistance", () => {
    it("returns euclidean distance between two points", () => {
      expect(touchDistance([0, 0], [3, 4])).toBe(5);
      expect(touchDistance([10, 10], [10, 10])).toBe(0);
    });

    it("is symmetric", () => {
      expect(touchDistance([1, 2], [4, 6])).toBe(touchDistance([4, 6], [1, 2]));
    });
  });

  describe("nextScale", () => {
    it("returns current scale on the very first pinch step (no last distance)", () => {
      expect(nextScale(1, 0, 200)).toBe(1);
      expect(nextScale(2, -1, 200)).toBe(2);
    });

    it("scales up when fingers spread apart", () => {
      // From distance 100 to 200 → factor 2 → scale 1 → 2
      expect(nextScale(1, 100, 200)).toBe(2);
    });

    it("scales down when fingers come together", () => {
      // 200 → 100 = factor 0.5 → scale 2 → 1
      expect(nextScale(2, 200, 100)).toBe(1);
    });

    it("clamps to MAX_SCALE so a fast pinch can't shoot the image off-screen", () => {
      // Aggressive 10x factor — must clamp to MAX
      expect(nextScale(2, 100, 1000)).toBe(MAX_SCALE);
    });

    it("clamps to MIN_SCALE so the image never shrinks below 1x", () => {
      // 0.1x factor would land at 0.1 — must clamp to 1
      expect(nextScale(1, 1000, 100)).toBe(MIN_SCALE);
    });

    it("guards against zero/negative current distance (degenerate touch payload)", () => {
      expect(nextScale(2, 100, 0)).toBe(2);
      expect(nextScale(2, 100, -5)).toBe(2);
    });
  });
});
