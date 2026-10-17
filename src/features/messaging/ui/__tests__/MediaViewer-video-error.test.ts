// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import { VIDEO_LOAD_TIMEOUT_MS } from "../../model/video-error";

/**
 * Audit S4-03: a gallery video that still failed after the viewer's one
 * recovery (re-minting a revoked blob URL), or that never loaded at all, stayed
 * a black screen with no error, retry or download. The inline chat bubble
 * already had typed errors and a load deadline; the viewer now shares them.
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

const videoMessage = {
  id: "v1",
  _key: "client_v1",
  roomId: "!room:server",
  senderId: "@u:server",
  timestamp: 1,
  type: "video",
  content: "v1.mp4",
  fileInfo: { name: "v1.mp4", type: "video/mp4", size: 20, url: "mxc://server/v1" },
};

vi.mock("@/entities/chat", () => ({
  MessageType: { text: "text", image: "image", video: "video", audio: "audio", file: "file" },
  useChatStore: () => ({ activeMediaMessages: [videoMessage] }),
}));

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

const mint = async (message: typeof videoMessage): Promise<string> => {
  const state = getState(message._key);
  state.objectUrl = `blob:${message._key}/${++mintCounter}`;
  return state.objectUrl;
};

const download = vi.fn(mint);

const saveFile = vi.fn(async () => {});

vi.mock("../../model/use-file-download", () => ({
  useFileDownload: () => ({ getState, download, saveFile, formatSize: vi.fn() }),
  invalidateDownloadCache: vi.fn(),
}));

const MediaViewer = (await import("../MediaViewer.vue")).default;

const openVideo = async () => {
  const wrapper = mount(MediaViewer, {
    props: { show: false, messageId: null as string | null },
    global: { stubs: { teleport: true } },
  });
  await wrapper.setProps({ messageId: "v1", show: true });
  await flushPromises();
  return wrapper;
};

const failVideo = async (wrapper: Awaited<ReturnType<typeof openVideo>>, code: number) => {
  const video = wrapper.find("video");
  Object.defineProperty(video.element, "error", { value: { code }, configurable: true });
  await video.trigger("error");
  await flushPromises();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  states.clear();
  mintCounter = 0;
  download.mockReset().mockImplementation(mint);
  saveFile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MediaViewer — gallery video errors (audit S4-03)", () => {
  it("re-mints a dead URL once, then names an unsupported format and offers only the download", async () => {
    const wrapper = await openVideo();
    expect(download).toHaveBeenCalledTimes(1);

    await failVideo(wrapper, 4);
    // First failure: the recovery re-mints the URL, no error shown yet.
    expect(download).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="media-video-error"]').exists()).toBe(false);

    await failVideo(wrapper, 4);
    const overlay = wrapper.find('[data-testid="media-video-error"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain("message.videoUnsupportedFormat");
    expect(wrapper.find('[data-testid="media-video-retry"]').exists()).toBe(false);

    await wrapper.find('[data-testid="media-video-download"]').trigger("click");
    await flushPromises();
    expect(saveFile).toHaveBeenCalledWith("blob:client_v1/2", "v1.mp4", "video/mp4");
    wrapper.unmount();
  });

  it("shows a load failure with retry when the video never loads", async () => {
    const wrapper = await openVideo();

    vi.advanceTimersByTime(VIDEO_LOAD_TIMEOUT_MS - 1);
    await flushPromises();
    expect(wrapper.find('[data-testid="media-video-error"]').exists()).toBe(false);

    vi.advanceTimersByTime(1);
    await flushPromises();
    const overlay = wrapper.find('[data-testid="media-video-error"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain("message.videoLoadFailed");

    await wrapper.find('[data-testid="media-video-retry"]').trigger("click");
    await flushPromises();
    expect(download).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="media-video-error"]').exists()).toBe(false);
    wrapper.unmount();
  });

  // Batch-4 review: a failed download leaves no URL, so the player never mounts.
  it("offers a retry when the download itself failed, instead of a spinner", async () => {
    download.mockImplementation(async (message: typeof videoMessage) => {
      const state = getState(message._key);
      state.error = "network";
      state.errorKind = "network";
      return null as unknown as string;
    });
    const wrapper = await openVideo();

    expect(wrapper.find("video").exists()).toBe(false);
    const overlay = wrapper.find('[data-testid="media-video-error"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain("message.videoLoadFailed");
    expect(wrapper.find('[data-testid="media-video-download"]').exists()).toBe(false);

    // The network is back: the retry fetches again and the player mounts.
    const callsBefore = download.mock.calls.length;
    download.mockImplementation(mint);
    await wrapper.find('[data-testid="media-video-retry"]').trigger("click");
    await flushPromises();
    expect(download.mock.calls.length).toBe(callsBefore + 1);
    expect(wrapper.find("video").exists()).toBe(true);
    expect(wrapper.find('[data-testid="media-video-error"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("stays quiet when the metadata arrives before the deadline", async () => {
    const wrapper = await openVideo();

    await wrapper.find("video").trigger("loadedmetadata");
    vi.advanceTimersByTime(VIDEO_LOAD_TIMEOUT_MS * 2);
    await flushPromises();

    expect(wrapper.find('[data-testid="media-video-error"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
