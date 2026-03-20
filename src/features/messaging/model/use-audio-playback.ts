import { ref, computed, shallowRef } from "vue";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

interface PlaybackInfo {
  messageId: string;
  roomId: string;
  objectUrl: string;
  duration: number;
}

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
    state.value = "failed";
  };
  el.onloadedmetadata = () => {
    duration.value = el.duration;
  };
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
      const el = new Audio(info.objectUrl);
      el.playbackRate = playbackRate.value;
      setupAudioListeners(el);
      audio.value = el;
      await el.play();
      state.value = "playing";
    } catch {
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
