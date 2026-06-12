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

// PeerTube API fetchers — control the native <video> path (WEE-82) per test.
let mockFileUrl: string | null = null;
const fetchPeerTubeFileUrl = vi.fn(() => Promise.resolve(mockFileUrl));
vi.mock("@/shared/lib/video-embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/video-embed")>();
  return {
    ...actual,
    fetchPeerTubeThumb: vi.fn(() => Promise.resolve("")),
    fetchPeerTubeFileUrl: () => fetchPeerTubeFileUrl(),
  };
});

import VideoPlayer from "../VideoPlayer.vue";

const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PT_URL = "peertube://videos.example.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// FeedVideoPlayer is stubbed: its own behavior is covered by
// use-feed-video-player.test.ts; here we only assert the routing decision.
const mountOptions = { global: { stubs: { FeedVideoPlayer: true } } };

beforeEach(() => {
  mockIsNative = false;
  mockFileUrl = null;
  openExternalUrl.mockClear();
  fetchPeerTubeFileUrl.mockClear();
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

describe("VideoPlayer native <video> path (WEE-82 / forta-bugs#963, #964)", () => {
  it("peertube в модалке на native рендерит нативный плеер вместо iframe", async () => {
    mockIsNative = true;
    mockFileUrl = "https://cdn.example.com/720.mp4";
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    const native = wrapper.find("[data-testid='native-player']");
    expect(native.exists()).toBe(true);
    expect(wrapper.find("iframe").exists()).toBe(false);
    // Position memory is keyed by the post video URL
    expect(native.attributes("persistkey") ?? native.attributes("persist-key")).toBe(PT_URL);
  });

  it("peertube без прямого файла откатывается на iframe-поток", async () => {
    mockIsNative = true;
    mockFileUrl = null;
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(false);
    // Old behavior intact: tap the overlay → iframe mounts
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find("iframe").exists()).toBe(true);
  });

  it("YouTube на native не запрашивает PeerTube API и остаётся на iframe", async () => {
    mockIsNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL }, ...mountOptions });
    await flushPromises();

    expect(fetchPeerTubeFileUrl).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(false);
  });

  it("inline peertube на native не тратит запрос за файлом — тап эмитит expand (WEE-74)", async () => {
    mockIsNative = true;
    mockFileUrl = "https://cdn.example.com/720.mp4";
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL, inline: true }, ...mountOptions });
    await flushPromises();

    expect(fetchPeerTubeFileUrl).not.toHaveBeenCalled();

    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("expand")).toHaveLength(1);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("на web peertube остаётся на iframe (native-путь только для Capacitor)", async () => {
    mockIsNative = false;
    mockFileUrl = "https://cdn.example.com/720.mp4";
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(fetchPeerTubeFileUrl).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(false);
  });

  it("тап по overlay до резолва файла оставляет iframe — плеер не переключается на лету", async () => {
    mockIsNative = true;
    let resolveFile!: (url: string | null) => void;
    fetchPeerTubeFileUrl.mockImplementationOnce(
      () => new Promise<string | null>((res) => { resolveFile = res; }),
    );
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    // User taps play while the file URL is still being resolved → iframe starts
    await wrapper.find("button").trigger("click");
    expect(wrapper.find("iframe").exists()).toBe(true);

    // Late resolve must NOT yank the running iframe out from under the user
    resolveFile("https://cdn.example.com/720.mp4");
    await flushPromises();

    expect(wrapper.find("iframe").exists()).toBe(true);
    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(false);
  });

  it("fatal-error нативного плеера откатывает на iframe-embed", async () => {
    mockIsNative = true;
    mockFileUrl = "https://cdn.example.com/720.mp4";
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(true);

    // Native playback died after all retries (expired link / undecodable fMP4)
    wrapper.findComponent({ name: "FeedVideoPlayer" }).vm.$emit("fatal-error");
    await flushPromises();

    expect(wrapper.find("[data-testid='native-player']").exists()).toBe(false);
    expect(wrapper.find("iframe").exists()).toBe(true);
  });
});

describe("VideoPlayer autoplay prop (WEE-82 / forta-bugs#963 single-tap)", () => {
  it("autoplay на web сразу монтирует iframe без тапа по overlay", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL, autoplay: true }, ...mountOptions });
    await flushPromises();

    const iframe = wrapper.find("iframe");
    expect(iframe.exists()).toBe(true);
    expect(iframe.attributes("src")).toContain("autoplay=1");
  });

  it("autoplay + peertube fallback на native сразу грузит iframe (один тап меньше)", async () => {
    mockIsNative = true;
    mockFileUrl = null;
    const wrapper = mount(VideoPlayer, {
      props: { url: PT_URL, autoplay: true },
      ...mountOptions,
    });
    await flushPromises();

    expect(wrapper.find("iframe").exists()).toBe(true);
  });

  it("autoplay + peertube native передаёт autoplay нативному плееру", async () => {
    mockIsNative = true;
    mockFileUrl = "https://cdn.example.com/720.mp4";
    const wrapper = mount(VideoPlayer, {
      props: { url: PT_URL, autoplay: true },
      ...mountOptions,
    });
    await flushPromises();

    const native = wrapper.find("[data-testid='native-player']");
    expect(native.exists()).toBe(true);
    // Stub renders props as attributes; boolean true → empty-string attr
    expect(native.attributes("autoplay")).toBeDefined();
  });

  it("без autoplay поведение прежнее — overlay ждёт тапа", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.find("button").exists()).toBe(true);
  });
});
