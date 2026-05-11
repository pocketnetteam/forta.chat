import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

// Mock platform detection
vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isIOS: false,
  isAndroid: false,
  isElectron: false,
  isWeb: true,
}));

// Mock bug-report so we can assert that the watchdog path doesn't fire it.
const mockBugReportOpen = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: mockBugReportOpen }),
}));

// Mock i18n to keep error-context lookups deterministic.
vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (k: string) => k,
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

    it("should clear roomId — enables room-change detection for invisible playback prevention", async () => {
      await playback.play(baseInfo);
      expect(playback.currentRoomId.value).toBe("room-1");

      playback.stop();

      expect(playback.currentRoomId.value).toBeNull();
      expect(mockPause).toHaveBeenCalled();
      expect(mockRemoveAttribute).toHaveBeenCalledWith("src");
    });

    it("should not trigger onEnded callback after stop", async () => {
      const cb = vi.fn();
      playback.setOnEnded(cb);

      await playback.play(baseInfo);
      playback.stop();

      // After stop, audio element is nulled — onended can't fire
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("isActive / isPlaying computed", () => {
    it("isActive should return true only for the playing message", async () => {
      const active1 = playback.isActive("msg-1");
      const active2 = playback.isActive("msg-2");

      await playback.play(baseInfo);

      expect(active1.value).toBe(true);
      expect(active2.value).toBe(false);
    });

    it("isPlaying should return false after stop", async () => {
      const playing1 = playback.isPlaying("msg-1");

      await playback.play(baseInfo);
      expect(playing1.value).toBe(true);

      playback.stop();
      expect(playing1.value).toBe(false);
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

// ---------------------------------------------------------------------------
// Watchdog regression — Session 44
// Reproduces issues #695, #671: voice message gets stuck in loading state
// when the encrypted blob's <audio> never reaches loadedmetadata. Without a
// watchdog, the user sees an infinite spinner; the cure is an 8s timeout
// that flips state → "failed" so the retry button is shown.
// ---------------------------------------------------------------------------
describe("useAudioPlayback watchdog (Session 44)", () => {
  let playback: ReturnType<typeof useAudioPlayback>;

  beforeEach(() => {
    vi.useFakeTimers();
    playback = useAudioPlayback();
    playback.stop();
    // Reset rate so tests don't inherit cycleSpeed leftovers from other blocks.
    playback.playbackRate.value = 1;
    mockPlay.mockClear();
    mockPause.mockClear();
    mockLoad.mockClear();
    mockRemoveAttribute.mockClear();
    mockBugReportOpen.mockClear();
    (Audio as unknown as Mock).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to 'failed' if loadedmetadata never fires within 8s", async () => {
    // Simulate hung encrypted blob: play() returns a never-resolving promise.
    mockPlay.mockReturnValue(new Promise(() => {}));

    // Don't await — play() will hang on the never-resolving promise.
    void playback.play(baseInfo);
    // Allow the synchronous part of play() to run (state = "loading", el = new Audio()).
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Advance past the 8s watchdog threshold.
    await vi.advanceTimersByTimeAsync(8000);

    expect(playback.state.value).toBe("failed");
  });

  it("does not transition to 'failed' if loadedmetadata fires before 8s", async () => {
    mockPlay.mockResolvedValueOnce(undefined);

    await playback.play(baseInfo);
    expect(playback.state.value).toBe("playing");

    // Fire loadedmetadata to clear the watchdog.
    const onloaded = lastAudio.onloadedmetadata as ((this: unknown) => void) | null;
    onloaded?.call(lastAudio);

    await vi.advanceTimersByTimeAsync(8000);

    expect(playback.state.value).not.toBe("failed");
    expect(playback.state.value).toBe("playing");
  });

  it("does not transition to 'failed' on watchdog if state has already moved on", async () => {
    mockPlay.mockResolvedValueOnce(undefined);

    await playback.play(baseInfo);
    // play() resolved → state = "playing"; user pauses before watchdog fires.
    playback.pause();
    expect(playback.state.value).toBe("paused");

    await vi.advanceTimersByTimeAsync(8000);

    // Watchdog must only flip state when it's still "loading".
    expect(playback.state.value).toBe("paused");
  });

  it("does not open the bug-report modal when the watchdog wins the race", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate the encrypted-blob hang: play() never resolves on its own.
    // After the watchdog calls pause()/removeAttribute("src")/load(), the
    // browser would normally reject the play() promise with AbortError.
    let rejectPlay: (e: Error) => void = () => {};
    mockPlay.mockReturnValue(new Promise((_, reject) => { rejectPlay = reject; }));

    void playback.play(baseInfo);
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Watchdog fires.
    await vi.advanceTimersByTimeAsync(8000);
    expect(playback.state.value).toBe("failed");

    // Now the browser rejects play() (deferred AbortError after src cleared).
    rejectPlay(new DOMException("The play() request was interrupted", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    // Must not show a bug-report modal — the watchdog already surfaced
    // the failure, and the AbortError is its own doing.
    expect(mockBugReportOpen).not.toHaveBeenCalled();
    expect(playback.state.value).toBe("failed");

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
