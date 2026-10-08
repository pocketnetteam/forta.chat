// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import PostImageGallery from "../PostImageGallery.vue";

const IMAGES = ["a.jpg", "b.jpg", "c.jpg"];
let wrapper: VueWrapper | null = null;

function mountGallery(props: { images: string[]; startIndex?: number }) {
  wrapper = mount(PostImageGallery, { props, attachTo: document.body });
  return wrapper;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const shownSrc = () => byTestId("post-image-gallery")?.querySelector("img")?.getAttribute("src");
const counter = () => byTestId("post-image-gallery-counter")?.textContent?.trim();

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("PostImageGallery", () => {
  it("opens on the start image and shows the counter", () => {
    mountGallery({ images: IMAGES, startIndex: 1 });
    expect(shownSrc()).toBe("b.jpg");
    expect(counter()).toBe("2 / 3");
  });

  it("arrows page through the images and stop at the ends", async () => {
    const w = mountGallery({ images: IMAGES });
    expect(byTestId("post-image-gallery-prev")).toBeNull();
    byTestId("post-image-gallery-next")?.click();
    await w.vm.$nextTick();
    byTestId("post-image-gallery-next")?.click();
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("c.jpg");
    expect(byTestId("post-image-gallery-next")).toBeNull();
    byTestId("post-image-gallery-prev")?.click();
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("b.jpg");
  });

  it("keyboard arrows navigate", async () => {
    const w = mountGallery({ images: IMAGES });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("b.jpg");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("a.jpg");
  });

  it("swipes from ZoomableImage navigate", async () => {
    const w = mountGallery({ images: IMAGES });
    const zoom = w.findComponent({ name: "ZoomableImage" });
    zoom.vm.$emit("swipe", "next");
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("b.jpg");
    zoom.vm.$emit("swipe", "prev");
    zoom.vm.$emit("swipe", "prev");
    await w.vm.$nextTick();
    expect(shownSrc()).toBe("a.jpg");
  });

  it("close button, Escape and swipe-down close the gallery", () => {
    const w = mountGallery({ images: IMAGES });
    byTestId("post-image-gallery-close")?.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    w.findComponent({ name: "ZoomableImage" }).vm.$emit("close");
    expect(w.emitted("close")).toHaveLength(3);
  });

  it("a single image hides the counter and arrows; an out-of-range start is clamped", () => {
    mountGallery({ images: ["only.jpg"], startIndex: 5 });
    expect(shownSrc()).toBe("only.jpg");
    expect(counter()).toBeUndefined();
    expect(byTestId("post-image-gallery-next")).toBeNull();
  });
});
