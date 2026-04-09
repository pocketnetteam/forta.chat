import { ref, computed, shallowRef } from "vue";
import { isNative } from "@/shared/lib/platform";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

interface PlaybackInfo {
  messageId: string;
  roomId: string;
  objectUrl: string;
  duration: number;
}

// ---------------------------------------------------------------------------
// iOS Silent Mode bypass via AudioContext unlock
// ---------------------------------------------------------------------------
// On iOS WKWebView, HTML5 Audio plays as "ambient" sound — muted by the
// hardware Silent Mode switch. Creating and resuming an AudioContext within
// a user gesture forces the AVAudioSession into playback mode, making all
// subsequent audio (including HTML5 Audio) audible regardless of the switch.
// ---------------------------------------------------------------------------
let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

function getOrCreateAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Must be called **synchronously** inside a click/tap handler.
 * Plays a 1-sample silent buffer to activate the iOS audio session.
 */
function unlockAudio(): void {
  if (audioUnlocked) return;

  try {
    const ctx = getOrCreateAudioContext();

    // Play a silent buffer to wake up the audio session
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // Resume failed — allow re-attempt on next user gesture
        audioUnlocked = false;
      });
    }

    audioUnlocked = true;
    console.log("[audio] AudioContext unlocked, state:", ctx.state);
  } catch (e) {
    console.warn("[audio] AudioContext unlock failed:", e);
  }
}

// On iOS, backgrounding the app suspends the AudioContext. Re-unlock on foreground
// to restore the playback audio session, otherwise sound silently stops working.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && audioCtx?.state === "suspended") {
      audioUnlocked = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Codec support detection
// ---------------------------------------------------------------------------
const codecCache = new Map<string, boolean>();

function canPlay(mimeType: string): boolean {
  if (codecCache.has(mimeType)) return codecCache.get(mimeType)!;
  const el = document.createElement("audio");
  const result = el.canPlayType(mimeType);
  const ok = result === "probably" || result === "maybe";
  codecCache.set(mimeType, ok);
  return ok;
}

/** Returns codec support map for the current platform. */
export function checkCodecSupport() {
  return {
    mp3: canPlay("audio/mpeg"),
    ogg: canPlay("audio/ogg; codecs=opus"),
    webm: canPlay("audio/webm; codecs=opus"),
    wav: canPlay("audio/wav"),
    aac: canPlay("audio/aac"),
  };
}

// ---------------------------------------------------------------------------
// Global singleton state
// ---------------------------------------------------------------------------
const audio = shallowRef<HTMLAudioElement | null>(null);
const state = ref<PlaybackState>("idle");
const currentMessageId = ref<string | null>(null);
const currentRoomId = ref<string | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const playbackRate = ref(1);

let onEndedCallback: ((messageId: string, roomId: string) => void) | null = null;

function cleanup() {
  if (audio.value) {
    audio.value.pause();
    audio.value.removeAttribute("src");
    audio.value.load();
  }
  audio.value = null;
  state.value = "idle";
  currentMessageId.value = null;
  currentRoomId.value = null;
  currentTime.value = 0;
  duration.value = 0;
}

function setupAudioListeners(el: HTMLAudioElement) {
  el.ontimeupdate = () => {
    currentTime.value = el.currentTime;
  };
  el.onended = () => {
    const msgId = currentMessageId.value;
    const roomId = currentRoomId.value;
    state.value = "ended";
    currentTime.value = 0;
    if (msgId && roomId && onEndedCallback) {
      onEndedCallback(msgId, roomId);
    }
  };
  el.onerror = () => {
    const err = el.error;
    console.error("[audio] playback error:", {
      code: err?.code,
      message: err?.message,
      codeName: ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"][err?.code ?? 0],
      networkState: el.networkState,
      readyState: el.readyState,
      src: el.src?.substring(0, 60),
    });
    state.value = "failed";
  };
  el.onloadedmetadata = () => {
    // Only update if finite — Chromium reports Infinity for webm blobs
    if (Number.isFinite(el.duration) && el.duration > 0) {
      duration.value = el.duration;
    }
  };

  // Diagnostic listeners (mobile debugging)
  if (isNative) {
    el.onstalled = () => console.warn("[audio] stalled");
    el.onsuspend = () => console.log("[audio] suspend");
    el.onwaiting = () => console.log("[audio] waiting");
    el.onabort = () => console.warn("[audio] abort");
  }
}

export function useAudioPlayback() {
  const isActive = (messageId: string) =>
    computed(() => currentMessageId.value === messageId);

  const isPlaying = (messageId: string) =>
    computed(() => currentMessageId.value === messageId && state.value === "playing");

  const progress = computed(() => {
    if (duration.value === 0) return 0;
    return currentTime.value / duration.value;
  });

  async function play(info: PlaybackInfo) {
    // Unlock audio session on first play (must be synchronous in user gesture)
    unlockAudio();

    if (currentMessageId.value === info.messageId && audio.value && state.value === "paused") {
      await audio.value.play();
      state.value = "playing";
      return;
    }
    if (currentMessageId.value === info.messageId && audio.value && state.value === "ended") {
      audio.value.currentTime = 0;
      await audio.value.play();
      state.value = "playing";
      return;
    }
    cleanup();
    state.value = "loading";
    currentMessageId.value = info.messageId;
    currentRoomId.value = info.roomId;
    duration.value = info.duration;

    try {
      const el = new Audio();
      el.playbackRate = playbackRate.value;
      setupAudioListeners(el);
      audio.value = el;

      // Set src and call play() synchronously — preserves user gesture chain.
      // The browser binds the play() Promise to the current user activation.
      el.src = info.objectUrl;
      await el.play();
      state.value = "playing";
    } catch (e: unknown) {
      const err = e as Error;
      console.error("[audio] play() rejected:", err.name, err.message);

      // NotAllowedError = autoplay blocked / user gesture expired
      // NotSupportedError = codec not supported
      if (err.name === "NotAllowedError") {
        console.error("[audio] User gesture likely expired before play(). " +
          "Ensure no async operations between click and play().");
      }
      state.value = "failed";
    }
  }

  function pause() {
    if (audio.value && state.value === "playing") {
      audio.value.pause();
      state.value = "paused";
    }
  }

  function togglePlay(info: PlaybackInfo) {
    if (currentMessageId.value === info.messageId && state.value === "playing") {
      pause();
    } else {
      play(info);
    }
  }

  function seek(time: number) {
    if (audio.value) {
      audio.value.currentTime = Math.max(0, Math.min(time, duration.value));
      currentTime.value = audio.value.currentTime;
    }
  }

  function seekByRatio(ratio: number) {
    seek(ratio * duration.value);
  }

  function skipForward(seconds = 5) {
    if (audio.value) seek(audio.value.currentTime + seconds);
  }

  function skipBackward(seconds = 5) {
    if (audio.value) seek(audio.value.currentTime - seconds);
  }

  function cycleSpeed() {
    const speeds = [1, 1.5, 2];
    const idx = speeds.indexOf(playbackRate.value);
    playbackRate.value = speeds[(idx + 1) % speeds.length];
    if (audio.value) audio.value.playbackRate = playbackRate.value;
  }

  function setOnEnded(cb: (messageId: string, roomId: string) => void) {
    onEndedCallback = cb;
  }

  function stop() {
    cleanup();
  }

  return {
    state, currentMessageId, currentRoomId, currentTime, duration, playbackRate, progress,
    isActive, isPlaying,
    play, pause, togglePlay, seek, seekByRatio, skipForward, skipBackward, cycleSpeed, setOnEnded, stop,
  };
}
