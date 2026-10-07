// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ZoomableImage from "../ZoomableImage.vue";

type Point = { x: number; y: number };

const touches = (points: Point[]) => points.map((p) => ({ clientX: p.x, clientY: p.y }));

async function swipe(w: VueWrapper, from: Point, to: Point) {
  const root = w.find("div");
  await root.trigger("touchstart", { touches: touches([from]) });
  await root.trigger("touchmove", { touches: touches([to]) });
  await root.trigger("touchend", { touches: [] });
}

describe("ZoomableImage horizontal swipe", () => {
  it("swipe left at 1x emits next, swipe right emits prev", async () => {
    const w = mount(ZoomableImage, { props: { src: "a.jpg" } });
    await swipe(w, { x: 200, y: 100 }, { x: 100, y: 105 });
    await swipe(w, { x: 100, y: 100 }, { x: 200, y: 95 });
    expect(w.emitted("swipe")).toEqual([["next"], ["prev"]]);
  });

  it("a short drag is not a swipe", async () => {
    const w = mount(ZoomableImage, { props: { src: "a.jpg" } });
    await swipe(w, { x: 200, y: 100 }, { x: 170, y: 100 });
    expect(w.emitted("swipe")).toBeUndefined();
  });

  it("a plain tap after a swipe does not re-emit the stale delta", async () => {
    const w = mount(ZoomableImage, { props: { src: "a.jpg" } });
    await swipe(w, { x: 200, y: 100 }, { x: 100, y: 100 });
    const root = w.find("div");
    await root.trigger("touchstart", { touches: touches([{ x: 50, y: 50 }]) });
    await root.trigger("touchend", { touches: [] });
    expect(w.emitted("swipe")).toHaveLength(1);
  });

  it("dragging while zoomed pans instead of swiping", async () => {
    const w = mount(ZoomableImage, { props: { src: "a.jpg" } });
    const root = w.find("div");
    // Double tap → 2x zoom.
    await root.trigger("click");
    await root.trigger("click");
    await swipe(w, { x: 200, y: 100 }, { x: 100, y: 100 });
    expect(w.emitted("swipe")).toBeUndefined();
  });
});
