import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import { __resetCirclePausesForTests, circleActionOnEnded } from "../../model/video-circle-pause";

/**
 * Audit W2C-03: a paused video circle started again whenever it scrolled back
 * into view (or the chat was reopened), and one played with sound looped.
 */

const state = reactive({ objectUrl: "blob:circle" as string | null, loading: false, error: null });
vi.mock("../../model/use-file-download", () => ({
  useFileDownload: () => ({ getState: () => state, download: vi.fn() }),
}));
vi.mock("@/shared/lib/composables/use-video-state-preservation", () => ({
  useVideoStatePreservation: vi.fn(),
}));

type IoCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: IoCallback[] = [];
class FakeObserver {
  constructor(cb: IoCallback) {
    observers.push(cb);
  }
  observe() {}
  disconnect() {}
}

const message = {
  id: "$circle",
  _key: "client_circle",
  roomId: "!r:s",
  senderId: "@u:s",
  timestamp: 1,
  type: "videoCircle",
  content: "",
  fileInfo: { name: "c.mp4", type: "video/mp4", size: 1, url: "mxc://s/c", duration: 5 },
};

const { default: VideoCirclePlayer } = await import("../VideoCirclePlayer.vue");

const mountCircle = async () => {
  const wrapper = mount(VideoCirclePlayer, { props: { message: message as never, isOwn: false } });
  await wrapper.find("video").trigger("canplay");
  return wrapper;
};
const scrollIntoView = async () => {
  observers.at(-1)!([{ isIntersecting: true }]);
  await flushPromises();
};

describe("VideoCirclePlayer", () => {
  let play: Mock<() => Promise<void>>;

  beforeEach(() => {
    __resetCirclePausesForTests();
    observers = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    play = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("autoplays muted in view, and stays paused after the user pauses it — also after reopening the chat", async () => {
    const wrapper = await mountCircle();
    await scrollIntoView();
    expect(play).toHaveBeenCalledTimes(1);

    await wrapper.trigger("click"); // unmute
    await flushPromises();
    await wrapper.trigger("click"); // pause
    await flushPromises();
    play.mockClear();

    await scrollIntoView();
    expect(play).not.toHaveBeenCalled();
    wrapper.unmount();

    const reopened = await mountCircle();
    await scrollIntoView();
    expect(play).not.toHaveBeenCalled();
    reopened.unmount();
  });

  it("stops at the end of a playback with sound instead of looping", async () => {
    const wrapper = await mountCircle();
    await scrollIntoView();
    await wrapper.trigger("click"); // unmute, keeps playing
    await flushPromises();
    play.mockClear();

    await wrapper.find("video").trigger("ended");
    await flushPromises();
    expect(play).not.toHaveBeenCalled();
    expect((wrapper.find("video").element as HTMLVideoElement).muted).toBe(true);
    wrapper.unmount();
  });

  it("loops a muted preview", () => {
    expect(circleActionOnEnded(true)).toBe("loop");
    expect(circleActionOnEnded(false)).toBe("stop");
  });
});
