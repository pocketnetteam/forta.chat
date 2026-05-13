import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for missing pan when zoomed (issues #712, #693).
 *
 * Sessions 33 wired pinch-to-zoom into MediaViewer but the `onTouchmove`
 * handler still early-returned for `scale.value > 1`, so a one-finger drag
 * after zoom did nothing. translateX/translateY were initialized and
 * applied in the template, but never updated — the photo sat frozen under
 * the user's finger.
 *
 * Source-level assertion mirrors the pattern in
 * MediaViewer-save-button.test.ts: mounting MediaViewer with TouchEvents in
 * happy-dom requires mocking the chat store, useFileDownload, the Android
 * back handler and video state preservation, which is brittle relative to
 * the small wiring we actually want to verify.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MediaViewer.vue"), "utf-8");

const extractTouchmove = (source: string): string => {
  const start = source.indexOf("const onTouchmove");
  if (start < 0) throw new Error("onTouchmove handler not found");
  const end = source.indexOf("const onTouchend", start);
  if (end < 0) throw new Error("end of onTouchmove not found");
  return source.slice(start, end);
};

describe("MediaViewer — pan when zoomed (Session 53)", () => {
  it("updates translateX.value inside onTouchmove (not only in resetTransform)", () => {
    const body = extractTouchmove(getSource());
    expect(body).toMatch(/translateX\.value\s*=/);
    expect(body).toMatch(/translateY\.value\s*=/);
  });

  it("does not early-return on scale > 1 without applying pan first", () => {
    const body = extractTouchmove(getSource());
    const lines = body.split("\n");
    const guardIdx = lines.findIndex((l) => /scale\.value\s*>\s*1[^a-z]*return/.test(l));
    if (guardIdx < 0) return; // guard removed entirely — pan path is unconditional, fine
    // If the guard still exists, translateX/Y assignment must happen before it
    // so panning still works for the zoomed case.
    const beforeGuard = lines.slice(0, guardIdx).join("\n");
    expect(beforeGuard).toMatch(/translateX\.value\s*=/);
  });

  it("captures pan start on touchstart when already zoomed", () => {
    const source = getSource();
    const start = source.indexOf("const onTouchstart");
    const end = source.indexOf("const onTouchmove", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // A pan-start anchor must be recorded so the delta in onTouchmove is
    // relative to the position when the finger first touched the screen,
    // not to (0,0) every frame.
    expect(body).toMatch(/panStart[XY]\s*=/);
  });

  it("removes transition-transform from the runtime gesture img", () => {
    const source = getSource();
    const imgStart = source.indexOf("<img");
    expect(imgStart).toBeGreaterThan(-1);
    const imgEnd = source.indexOf("/>", imgStart);
    const imgTag = source.slice(imgStart, imgEnd);
    // The CSS transition introduced gesture-perceived lag — pan/pinch must
    // apply transform directly without the 200ms ease.
    expect(imgTag).not.toMatch(/transition-transform/);
  });
});
