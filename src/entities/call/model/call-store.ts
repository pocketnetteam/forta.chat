import { defineStore } from "pinia";
import { ref, computed, shallowRef, triggerRef } from "vue";
import type { CallInfo, CallHistoryEntry } from "./types";
import { CallStatus } from "./types";

const NAMESPACE = "call";

export const useCallStore = defineStore(NAMESPACE, () => {
  const activeCall = ref<CallInfo | null>(null);
  const matrixCall = shallowRef<any>(null);
  const localStream = shallowRef<MediaStream | null>(null);
  const remoteStream = shallowRef<MediaStream | null>(null);
  const audioMuted = ref(false);
  const videoMuted = ref(false);
  const screenSharing = ref(false);
  const remoteVideoMuted = ref(false);
  const localScreenStream = shallowRef<MediaStream | null>(null);
  const remoteScreenStream = shallowRef<MediaStream | null>(null);
  const remoteScreenSharing = ref(false);
  const pinnedTile = ref<string | null>(null);
  const callTimer = ref(0);
  const history = ref<CallHistoryEntry[]>([]);
  const audioOutputId = ref(localStorage.getItem("bastyon_call_output_device") ?? "");

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let scheduledClearId: ReturnType<typeof setTimeout> | null = null;

  const isInCall = computed(
    () =>
      activeCall.value !== null &&
      activeCall.value.status !== CallStatus.idle &&
      activeCall.value.status !== CallStatus.ended &&
      activeCall.value.status !== CallStatus.failed,
  );

  const isRinging = computed(
    () =>
      activeCall.value?.status === CallStatus.ringing ||
      activeCall.value?.status === CallStatus.incoming,
  );

  function setActiveCall(call: CallInfo) {
    activeCall.value = call;
  }

  /** Cancel any pending scheduled clearCall */
  function cancelScheduledClear() {
    if (scheduledClearId !== null) {
      clearTimeout(scheduledClearId);
      scheduledClearId = null;
    }
  }

  function clearCall() {
    cancelScheduledClear();
    stopTimer();
    // Belt-and-suspenders: remove all listeners from the MatrixCall
    try {
      matrixCall.value?.removeAllListeners?.();
    } catch { /* ignore */ }
    activeCall.value = null;
    matrixCall.value = null;
    localStream.value = null;
    remoteStream.value = null;
    audioMuted.value = false;
    videoMuted.value = false;
    screenSharing.value = false;
    remoteVideoMuted.value = false;
    localScreenStream.value = null;
    remoteScreenStream.value = null;
    remoteScreenSharing.value = false;
    pinnedTile.value = null;
    callTimer.value = 0;
    // Note: audioOutputId is NOT reset — it's a user preference across calls
  }

  /** Schedule a clearCall after `delayMs`. Cancels any prior scheduled clear. */
  function scheduleClearCall(delayMs: number) {
    cancelScheduledClear();
    scheduledClearId = setTimeout(() => {
      scheduledClearId = null;
      clearCall();
    }, delayMs);
  }

  function updateStatus(status: CallStatus) {
    if (activeCall.value) {
      activeCall.value = { ...activeCall.value, status };
    }
  }

  function setMatrixCall(call: any) {
    matrixCall.value = call;
  }

  function setLocalStream(stream: MediaStream | null) {
    localStream.value = stream;
    // Force reactivity even for same-reference assignment (SDK swaps tracks
    // inside the same MediaStream object). The bindStream guard in CallWindow
    // prevents unnecessary srcObject reassignment, so this is safe.
    triggerRef(localStream);
  }

  function setRemoteStream(stream: MediaStream | null) {
    remoteStream.value = stream;
    triggerRef(remoteStream);
  }

  function setLocalScreenStream(stream: MediaStream | null) {
    localScreenStream.value = stream;
    triggerRef(localScreenStream);
  }

  function setRemoteScreenStream(stream: MediaStream | null) {
    remoteScreenStream.value = stream;
    triggerRef(remoteScreenStream);
  }

  function setPinnedTile(tileId: string | null) {
    pinnedTile.value = tileId;
  }

  function startTimer() {
    callTimer.value = 0;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      callTimer.value++;
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function addHistoryEntry(entry: CallHistoryEntry) {
    history.value.unshift(entry);
  }

  return {
    activeCall,
    matrixCall,
    localStream,
    remoteStream,
    audioMuted,
    videoMuted,
    screenSharing,
    remoteVideoMuted,
    localScreenStream,
    remoteScreenStream,
    remoteScreenSharing,
    pinnedTile,
    callTimer,
    history,
    audioOutputId,
    isInCall,
    isRinging,
    setActiveCall,
    clearCall,
    scheduleClearCall,
    cancelScheduledClear,
    updateStatus,
    setMatrixCall,
    setLocalStream,
    setRemoteStream,
    setLocalScreenStream,
    setRemoteScreenStream,
    setPinnedTile,
    startTimer,
    stopTimer,
    addHistoryEntry,
  };
});
