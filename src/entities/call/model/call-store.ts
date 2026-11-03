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
  const minimized = ref(false);
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

  /**
   * True while a call occupies the single call slot — including the window
   * where the SDK has a MatrixCall but no CallInfo has been written yet.
   *
   * On Android an incoming call rings through Telecom and `setActiveCall`
   * is deferred until the user actually answers, so `isInCall` stays false
   * for the entire ring. Re-entry guards keyed on `isInCall` therefore let a
   * second call take the slot mid-ring and orphan the first one: the call
   * the user then answered had already been unwired (#1183).
   *
   * A MatrixCall the SDK has already ended does not count — but only if
   * something told us: `state` is a plain field on the SDK object, not a
   * reactive one, so mutating it in place triggers nothing and this computed
   * keeps its cached answer. `touchMatrixCall` is what makes the check real;
   * the call-service state handler calls it on every SDK transition. Without
   * that, the ~1.5s between a call ending and `scheduleClearCall` nulling the
   * slot would reject a new incoming call.
   */
  const hasLiveCall = computed(
    () =>
      isInCall.value ||
      (matrixCall.value != null && matrixCall.value.state !== "ended"),
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
    minimized.value = false;
    callTimer.value = 0;
    // Note: audioOutputId is NOT reset — it's a user preference across calls
  }

  /** The call in the single slot right now, if any. */
  function slotOwner(): string | null {
    return matrixCall.value?.callId ?? activeCall.value?.callId ?? null;
  }

  /**
   * Schedule a clearCall after `delayMs` for the call in the slot now.
   * Cancels any prior scheduled clear. If another call has taken the slot by
   * then, nothing is cleared: clearCall strips every listener from the
   * MatrixCall in the slot, and the newer call lost its handlers — its end was
   * never handled and its Telecom connection stayed DIALING for 30 minutes
   * (Samsung, a dial that crossed an incoming call, 2026-10-04).
   */
  function scheduleClearCall(delayMs: number) {
    cancelScheduledClear();
    const owner = slotOwner();
    scheduledClearId = setTimeout(() => {
      scheduledClearId = null;
      const current = slotOwner();
      if (owner && current && current !== owner) {
        console.info("[call-store] clear for", owner, "skipped — the slot now holds", current);
        return;
      }
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

  /**
   * Re-notify readers of `matrixCall` after the SDK mutated the call object
   * in place. `matrixCall` is a shallowRef, so a changed `state` on the same
   * object is invisible to `hasLiveCall` until the ref itself is triggered.
   */
  function touchMatrixCall() {
    triggerRef(matrixCall);
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
    minimized,
    callTimer,
    history,
    audioOutputId,
    isInCall,
    hasLiveCall,
    isRinging,
    setActiveCall,
    clearCall,
    scheduleClearCall,
    cancelScheduledClear,
    updateStatus,
    setMatrixCall,
    touchMatrixCall,
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
