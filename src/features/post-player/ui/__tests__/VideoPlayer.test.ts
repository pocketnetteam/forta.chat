import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Mutable platform mock — `mock` prefix lets the hoisted factory reference it.
let mockIsNative = false;
vi.mock("@/shared/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/platform")>();
  return {
    ...actual,
    get isNative() {
      return mockIsNative;
    },
  };
});

// Browser fallback must never be a real no-op `window.open` on native; spy on it.
const openExternalUrl = vi.fn();
vi.mock("@/shared/lib/open-external-url", () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

import VideoPlayer from "../VideoPlayer.vue";

const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

beforeEach(() => {
  mockIsNative = false;
  openExternalUrl.mockClear();
});

describe("VideoPlayer iframe security", () => {
  it("renders iframe with sandbox attribute set after play is clicked", async () => {
    const wrapper = mount(VideoPlayer, {
      props: { url: YT_URL },
    });

    expect(wrapper.find("iframe").exists()).toBe(false);

    await wrapper.find("button").trigger("click");
    await flushPromises();

    const iframe = wrapper.find("iframe");
    expect(iframe.exists()).toBe(true);

    const sandbox = iframe.attributes("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-presentation");
  });
});

describe("VideoPlayer channel spinner (WEE-70)", () => {
  it("после @load iframe скрывает loading-overlay", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    // Spinner shown while the iframe is still loading.
    expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(true);

    await wrapper.find("iframe").trigger("load");
    await flushPromises();

    // Spinner disappears once the iframe reports load.
    expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(false);
  });

  it("на native не добавляет ?autoplay=1 в iframe src", async () => {
    mockIsNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    const src = wrapper.find("iframe").attributes("src") ?? "";
    expect(src).not.toContain("autoplay");
    expect(src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  it("на web сохраняет ?autoplay=1 в iframe src", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    const src = wrapper.find("iframe").attributes("src") ?? "";
    expect(src).toContain("autoplay=1");
  });

  it("показывает «открыть внешне» сразу после тапа play (не только по error)", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);
  });

  it("прячет overlay-спиннер по таймауту, даже если @load не сработал", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

      await wrapper.find("button").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(true);

      // No @load ever fires — spinner must still go away after the timeout.
      await vi.advanceTimersByTimeAsync(10_001);
      await flushPromises();

      expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(false);
      // External fallback remains reachable.
      expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("на native «открыть внешне» уходит через openExternalUrl, а не window.open", async () => {
    mockIsNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    await wrapper.find("[data-testid='video-external']").trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(YT_URL);
  });
});

describe("VideoPlayer channel feed touch/scroll lock (WEE-74)", () => {
  it("inline на native не встраивает iframe в ленту, а эмитит expand", async () => {
    mockIsNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL, inline: true } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    // No iframe is mounted in the feed — so it can't capture touch/scroll.
    expect(wrapper.find("iframe").exists()).toBe(false);
    // The host is asked to open the post modal instead.
    expect(wrapper.emitted("expand")).toHaveLength(1);
  });

  it("inline на web сохраняет встроенное воспроизведение (мышь, не Android WebView)", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL, inline: true } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    // Desktop has no touch gesture-lock, so inline playback stays.
    expect(wrapper.find("iframe").exists()).toBe(true);
    expect(wrapper.emitted("expand")).toBeUndefined();
  });

  it("в модалке (inline=false) на native играет встроенно, не эмитит expand", async () => {
    mockIsNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    // Modal context: the iframe is fine here — it doesn't lock the channel feed.
    expect(wrapper.find("iframe").exists()).toBe(true);
    expect(wrapper.emitted("expand")).toBeUndefined();
  });
});
