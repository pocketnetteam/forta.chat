import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Mock platform detection
vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isIOS: false,
  isAndroid: false,
  isElectron: false,
  isWeb: true,
}));

// --- Mock Audio (must use regular function for `new` operator) ---
const mockPlay = vi.fn(() => Promise.resolve());
const mockPause = vi.fn();
const mockLoad = vi.fn();
const mockRemoveAttribute = vi.fn();

let lastAudio: Record<string, unknown>;

vi.stubGlobal("Audio", vi.fn(function MockAudio(this: Record<string, unknown>) {
  this.play = mockPlay;
  this.pause = mockPause;
  this.load = mockLoad;
  this.removeAttribute = mockRemoveAttribute;
  this.src = "";
  this.currentTime = 0;
  this.duration = 10;
  this.playbackRate = 1;
  this.paused = true;
  this.muted = false;
  this.volume = 1;
  this.error = null;
  this.networkState = 0;
  this.readyState = 0;
  this.ontimeupdate = null;
  this.onended = null;
  this.onerror = null;
  this.onloadedmetadata = null;
  this.onstalled = null;
  this.onsuspend = null;
  this.onwaiting = null;
  this.onabort = null;
  lastAudio = this;
}));

// --- Mock AudioContext (must use regular function for `new`) ---
const mockCtxStart = vi.fn();
const mockCtxConnect = vi.fn();
const mockCtxResume = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal("AudioContext", vi.fn(function MockAudioContext(this: Record<string, unknown>) {
  this.state = "running";
  this.resume = mockCtxResume;
  this.createBuffer = vi.fn(() => ({}));
  this.createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: mockCtxConnect,
    start: mockCtxStart,
  }));
  this.destination = {};
}));

// Import AFTER mocks are set up
import { useAudioPlayback, checkCodecSupport } from "./use-audio-playback";

const baseInfo = {
  messageId: "msg-1",
  roomId: "room-1",
  objectUrl: "blob:http://localhost/abc",
  duration: 10,
};

describe("useAudioPlayback", () => {
  let playback: ReturnType<typeof useAudioPlayback>;

  beforeEach(() => {
    playback = useAudioPlayback();
    playback.stop();
    mockPlay.mockClear();
    mockPlay.mockImplementation(() => Promise.resolve());
    mockPause.mockClear();
    mockLoad.mockClear();
    mockRemoveAttribute.mockClear();
    (Audio as unknown as Mock).mockClear();
  });

  describe("play()", () => {
    it("should transition to playing state on successful play", async () => {
      await playback.play(baseInfo);

      expect(playback.state.value).toBe("playing");
      expect(playback.currentMessageId.value).toBe("msg-1");
      expect(playback.currentRoomId.value).toBe("room-1");
    });

    it("should set src on Audio element before calling play()", async () => {
      await playback.play(baseInfo);

      expect(Audio).toHaveBeenCalled();
      expect(lastAudio.src).toBe("blob:http://localhost/abc");
      expect(mockPlay).toHaveBeenCalled();
    });

    it("should unlock AudioContext on first play", async () => {
      // AudioContext is created during the first play() call
      await playback.play(baseInfo);

      expect(AudioContext).toHaveBeenCalled();
    });

    it("should set failed state when play() rejects with NotAllowedError", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPlay.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));

      await playback.play(baseInfo);

      expect(playback.state.value).toBe("failed");
      consoleSpy.mockRestore();
    });

    it("should resume from paused state without creating new Audio", async () => {
      await playback.play(baseInfo);
      playback.pause();
      expect(playback.state.value).toBe("paused");

      const callCountBefore = (Audio as unknown as Mock).mock.calls.length;
      await playback.play(baseInfo);

      expect(playback.state.value).toBe("playing");
      expect((Audio as unknown as Mock).mock.calls.length).toBe(callCountBefore);
    });

    it("should restart from ended state", async () => {
      await playback.play(baseInfo);

      // Simulate ended event
      const onended = lastAudio.onended as (() => void) | null;
      onended?.();
      expect(playback.state.value).toBe("ended");

      await playback.play(baseInfo);
      expect(playback.state.value).toBe("playing");
      expect(lastAudio.currentTime).toBe(0);
    });

    it("should cleanup previous audio when playing a different message", async () => {
      await playback.play(baseInfo);

      await playback.play({ ...baseInfo, messageId: "msg-2" });

      expect(mockPause).toHaveBeenCalled();
      expect(mockRemoveAttribute).toHaveBeenCalledWith("src");
      expect(playback.currentMessageId.value).toBe("msg-2");
    });
  });

  describe("pause()", () => {
    it("should pause and set paused state", async () => {
      await playback.play(baseInfo);
      playback.pause();

      expect(mockPause).toHaveBeenCalled();
      expect(playback.state.value).toBe("paused");
    });

    it("should do nothing when not playing", () => {
      playback.pause();
      expect(playback.state.value).not.toBe("paused");
    });
  });

  describe("togglePlay()", () => {
    it("should pause if currently playing same message", async () => {
      await playback.play(baseInfo);
      playback.togglePlay(baseInfo);

      expect(playback.state.value).toBe("paused");
    });
  });

  describe("seek()", () => {
    it("should clamp seek within valid range", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 10;

      playback.seek(-5);
      expect(lastAudio.currentTime).toBe(0);

      playback.seek(15);
      expect(lastAudio.currentTime).toBe(10);

      playback.seek(5);
      expect(lastAudio.currentTime).toBe(5);
    });
  });

  describe("seekByRatio()", () => {
    it("should seek to correct position based on ratio", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 20;

      playback.seekByRatio(0.5);
      expect(lastAudio.currentTime).toBe(10);
    });
  });

  describe("cycleSpeed()", () => {
    it("should cycle through 1 -> 1.5 -> 2 -> 1", async () => {
      await playback.play(baseInfo);

      expect(playback.playbackRate.value).toBe(1);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(1.5);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(2);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(1);
    });

    it("should apply playbackRate to audio element", async () => {
      await playback.play(baseInfo);
      playback.cycleSpeed();
      expect(lastAudio.playbackRate).toBe(1.5);
    });
  });

  describe("setOnEnded()", () => {
    it("should call callback when audio ends", async () => {
      const cb = vi.fn();
      playback.setOnEnded(cb);

      await playback.play(baseInfo);
      const onended = lastAudio.onended as (() => void) | null;
      onended?.();

      expect(cb).toHaveBeenCalledWith("msg-1", "room-1");
    });
  });

  describe("error diagnostics", () => {
    it("should log detailed error info on audio error event", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await playback.play(baseInfo);

      lastAudio.error = { code: 4, message: "Not supported" } as MediaError;
      const onerror = lastAudio.onerror as (() => void) | null;
      onerror?.();

      expect(playback.state.value).toBe("failed");
      expect(consoleSpy).toHaveBeenCalledWith(
        "[audio] playback error:",
        expect.objectContaining({
          code: 4,
          codeName: "SRC_NOT_SUPPORTED",
        }),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("progress computed", () => {
    it("should compute progress as ratio of currentTime/duration", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 20;
      playback.currentTime.value = 5;

      expect(playback.progress.value).toBe(0.25);
    });

    it("should return 0 when duration is 0", () => {
      expect(playback.progress.value).toBe(0);
    });
  });

  describe("stop()", () => {
    it("should cleanup and reset to idle", async () => {
      await playback.play(baseInfo);
      playback.stop();

      expect(playback.state.value).toBe("idle");
      expect(playback.currentMessageId.value).toBeNull();
      expect(playback.currentTime.value).toBe(0);
    });
  });
});

describe("checkCodecSupport", () => {
  it("should return codec support map with boolean values", () => {
    const support = checkCodecSupport();

    expect(support).toHaveProperty("mp3");
    expect(support).toHaveProperty("ogg");
    expect(support).toHaveProperty("webm");
    expect(support).toHaveProperty("wav");
    expect(support).toHaveProperty("aac");
    expect(typeof support.mp3).toBe("boolean");
  });
});
