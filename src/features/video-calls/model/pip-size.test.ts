import { describe, it, expect } from "vitest";
import {
  computePipSize,
  PIP_LONG_EDGE_MOBILE,
  PIP_LONG_EDGE_DESKTOP,
  PIP_MIN_ASPECT,
  PIP_MAX_ASPECT,
} from "./pip-size";

describe("computePipSize", () => {
  it("uses the desktop long edge as the width for landscape sources", () => {
    // 16:9 landscape camera on desktop
    const size = computePipSize(16 / 9, false);
    expect(size.w).toBe(PIP_LONG_EDGE_DESKTOP);
    expect(size.h).toBe(Math.round(PIP_LONG_EDGE_DESKTOP / (16 / 9)));
    expect(size.w).toBeGreaterThan(size.h);
  });

  it("uses the long edge as the height for portrait sources (the #433 case)", () => {
    // 9:16 portrait phone front camera on mobile — must NOT be cropped square
    const aspect = 9 / 16;
    const size = computePipSize(aspect, true);
    expect(size.h).toBe(PIP_LONG_EDGE_MOBILE);
    expect(size.w).toBe(Math.round(PIP_LONG_EDGE_MOBILE * aspect));
    expect(size.h).toBeGreaterThan(size.w);
  });

  it("produces a square when the source is 1:1", () => {
    const size = computePipSize(1, false);
    expect(size.w).toBe(size.h);
    expect(size.w).toBe(PIP_LONG_EDGE_DESKTOP);
  });

  it("falls back to a 4:3 landscape box when aspect is null", () => {
    const size = computePipSize(null, false);
    expect(size.w).toBe(PIP_LONG_EDGE_DESKTOP);
    expect(size.w).toBeGreaterThan(size.h);
    // 4:3 → height is three quarters of width
    expect(size.h).toBe(Math.round(PIP_LONG_EDGE_DESKTOP / (4 / 3)));
  });

  it("uses the smaller long edge on mobile", () => {
    const mobile = computePipSize(16 / 9, true);
    const desktop = computePipSize(16 / 9, false);
    expect(mobile.w).toBe(PIP_LONG_EDGE_MOBILE);
    expect(desktop.w).toBe(PIP_LONG_EDGE_DESKTOP);
    expect(mobile.w).toBeLessThan(desktop.w);
  });

  it("clamps an ultrawide source so the thumbnail never becomes a sliver", () => {
    const size = computePipSize(5, false); // 5:1 ultrawide screen share
    // Clamped to PIP_MAX_ASPECT → height stays above the un-clamped value
    expect(size.h).toBe(Math.round(PIP_LONG_EDGE_DESKTOP / PIP_MAX_ASPECT));
  });

  it("clamps an extremely tall source", () => {
    const size = computePipSize(0.1, true); // 1:10 pathological
    expect(size.w).toBe(Math.round(PIP_LONG_EDGE_MOBILE * PIP_MIN_ASPECT));
    expect(size.h).toBe(PIP_LONG_EDGE_MOBILE);
  });

  it("ignores invalid aspects (NaN, 0, negative) and falls back", () => {
    const fallback = computePipSize(null, false);
    expect(computePipSize(Number.NaN, false)).toEqual(fallback);
    expect(computePipSize(0, false)).toEqual(fallback);
    expect(computePipSize(-2, false)).toEqual(fallback);
    expect(computePipSize(Number.POSITIVE_INFINITY, false)).toEqual(fallback);
  });
});
