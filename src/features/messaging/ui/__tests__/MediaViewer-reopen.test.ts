import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

/**
 * Regression: an image opened a second time showed a blank black screen.
 *
 * MediaViewer only ever initialised itself from a *change* of `messageId`, so
 * reopening the same photo skipped every reset: the index stayed where a swipe
 * had left it, the zoom/pan transform stayed applied (a zoomed photo reopened
 * off-screen), and a stale `objectUrl` — a blob URL another `useFileDownload()`
 * consumer had already revoked — was handed straight to `<img>` while the
 * "already have a URL" guard suppressed the re-download.
 */

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "en" } }),
}));

vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

vi.mock("@/shared/lib/composables/use-video-state-preservation", () => ({
  useVideoStatePreservation: vi.fn(),
}));

interface MockMessage {
  id: string;
  _key: string;
  roomId: string;
  senderId: string;
  timestamp: number;
  type: string;
  content: string;
  fileInfo: { name: string; type: string; size: number; url: string };
}

const makeMessage = (id: string): MockMessage => ({
  id,
  _key: `client_${id}`,
  roomId: "!room:server",
  senderId: "@u:server",
  timestamp: 1,
  type: "image",
  content: `${id}.jpg`,
  fileInfo: { name: `${id}.jpg`, type: "image/jpeg", size: 10, url: `mxc://server/${id}` },
});

const videoMessage = { ...makeMessage("v1"), type: "video", content: "v1.mp4" };
videoMessage.fileInfo = { name: "v1.mp4", type: "video/mp4", size: 20, url: "mxc://server/v1" };

const mediaMessages = [makeMessage("m1"), makeMessage("m2"), videoMessage];

vi.mock("@/entities/chat", () => ({
  MessageType: { text: "text", image: "image", video: "video", audio: "audio", file: "file" },
  useChatStore: () => ({ activeMediaMessages: mediaMessages }),
}));

// --- useFileDownload mock: per-instance reactive states + a minting download ---
type MockState = {
  loading: boolean;
  error: string | null;
  errorKind: string | null;
  objectUrl: string | null;
  blob: Blob | null;
};

const states = new Map<string, MockState>();
let mintCounter = 0;

const getState = (key: string): MockState => {
  let state = states.get(key);
  if (!state) {
    state = reactive({ loading: false, error: null, errorKind: null, objectUrl: null, blob: null });
    states.set(key, state);
  }
  return state;
};

const download = vi.fn(async (message: MockMessage) => {
  const key = message._key || message.id;
  const state = getState(key);
  state.objectUrl = `blob:${key}/${++mintCounter}`;
  return state.objectUrl;
});

const invalidateDownloadCache = vi.fn();

vi.mock("../../model/use-file-download", () => ({
  useFileDownload: () => ({ getState, download, saveFile: vi.fn(), formatSize: vi.fn() }),
  invalidateDownloadCache: (key: string) => invalidateDownloadCache(key),
}));

const MediaViewer = (await import("../MediaViewer.vue")).default;

const mountViewer = () =>
  mount(MediaViewer, {
    props: { show: false, messageId: null as string | null },
    global: { stubs: { teleport: true } },
  });

const openWith = async (wrapper: ReturnType<typeof mountViewer>, messageId: string) => {
  await wrapper.setProps({ messageId, show: true });
  await flushPromises();
};

const close = async (wrapper: ReturnType<typeof mountViewer>) => {
  await wrapper.setProps({ show: false });
  await flushPromises();
};

beforeEach(() => {
  states.clear();
  mintCounter = 0;
  download.mockClear();
  invalidateDownloadCache.mockClear();
});

describe("MediaViewer — reopening the same image", () => {
  it("downloads the full-size image on first open", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");

    expect(download).toHaveBeenCalledTimes(1);
    expect(wrapper.find("img").attributes("src")).toBe("blob:client_m1/1");
    wrapper.unmount();
  });

  it("re-downloads on reopen when the object URL was dropped in between", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");
    await close(wrapper);

    // Another consumer unmounting revoked the shared blob URL and cleared it.
    getState("client_m1").objectUrl = null;
    download.mockClear();

    await openWith(wrapper, "m1");

    expect(download).toHaveBeenCalledTimes(1);
    expect(wrapper.find("img").attributes("src")).toBe("blob:client_m1/2");
    wrapper.unmount();
  });

  it("recovers from a revoked (dead) object URL via the <img> error handler", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");

    const deadUrl = getState("client_m1").objectUrl;
    download.mockClear();

    // The blob was revoked elsewhere: the string is still in state, so the
    // "already have a URL" guard would otherwise suppress any recovery.
    await wrapper.find("img").trigger("error");
    await flushPromises();

    expect(invalidateDownloadCache).toHaveBeenCalledWith("client_m1");
    expect(download).toHaveBeenCalledTimes(1);
    expect(wrapper.find("img").attributes("src")).not.toBe(deadUrl);
    wrapper.unmount();
  });

  it("retries the dead URL only once per viewing session", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");
    download.mockClear();

    await wrapper.find("img").trigger("error");
    await flushPromises();
    await wrapper.find("img").trigger("error");
    await flushPromises();

    expect(download).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("resets the index so a swipe before closing does not win the next open", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");

    await wrapper.find("[tabindex]").trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(wrapper.find("img").attributes("src")).toContain("client_m2");

    await close(wrapper);
    await openWith(wrapper, "m1");

    expect(wrapper.find("img").attributes("src")).toContain("client_m1");
    wrapper.unmount();
  });

  it("resets zoom on reopen so a zoomed-and-panned photo is not off-screen", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "m1");

    // Double-tap zooms to 2x.
    const stage = wrapper.find("img").element.parentElement!;
    stage.dispatchEvent(new Event("click"));
    stage.dispatchEvent(new Event("click"));
    await flushPromises();
    expect(wrapper.find("img").attributes("style")).toContain("scale(2)");

    await close(wrapper);
    await openWith(wrapper, "m1");

    expect(wrapper.find("img").attributes("style")).toContain("scale(1)");
    wrapper.unmount();
  });

  it("recovers a video whose object URL was revoked", async () => {
    const wrapper = mountViewer();
    await openWith(wrapper, "v1");

    // The gallery can open a video the feed never downloaded.
    expect(download).toHaveBeenCalledTimes(1);
    const deadUrl = wrapper.find("video").attributes("src");
    download.mockClear();

    await wrapper.find("video").trigger("error");
    await flushPromises();

    expect(invalidateDownloadCache).toHaveBeenCalledWith("client_v1");
    expect(download).toHaveBeenCalledTimes(1);
    expect(wrapper.find("video").attributes("src")).not.toBe(deadUrl);
    wrapper.unmount();
  });
});
