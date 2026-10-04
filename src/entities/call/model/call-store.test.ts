import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useCallStore } from "./call-store";
import { CallStatus } from "./types";
import type { CallInfo, CallHistoryEntry } from "./types";

function makeCallInfo(overrides: Partial<CallInfo> = {}): CallInfo {
  return {
    callId: "call_1",
    roomId: "!room:server",
    peerId: "@peer:server",
    peerAddress: "PeerAddr123",
    peerName: "Peer",
    type: "voice",
    direction: "outgoing",
    status: CallStatus.connecting,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<CallHistoryEntry> = {}): CallHistoryEntry {
  return {
    id: `h_${Math.random().toString(36).slice(2)}`,
    roomId: "!room:server",
    peerId: "@peer:server",
    peerName: "Peer",
    type: "voice",
    direction: "outgoing",
    status: "answered",
    startedAt: Date.now(),
    duration: 60,
    ...overrides,
  };
}

describe("call-store", () => {
  let store: ReturnType<typeof useCallStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useCallStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── setActiveCall / clearCall ────────────────────────────────

  describe("setActiveCall / clearCall", () => {
    it("sets the active call", () => {
      const call = makeCallInfo();
      store.setActiveCall(call);
      expect(store.activeCall).toEqual(call);
    });

    it("clearCall resets all state except audioOutputId", () => {
      store.setActiveCall(makeCallInfo());
      store.audioMuted = true;
      store.videoMuted = true;
      store.screenSharing = true;
      store.minimized = true;
      store.audioOutputId = "device123";

      store.clearCall();

      expect(store.activeCall).toBeNull();
      expect(store.audioMuted).toBe(false);
      expect(store.videoMuted).toBe(false);
      expect(store.screenSharing).toBe(false);
      expect(store.minimized).toBe(false);
      expect(store.callTimer).toBe(0);
      // audioOutputId preserved!
      expect(store.audioOutputId).toBe("device123");
    });
  });

  // ─── isInCall / isRinging computeds ───────────────────────────

  describe("isInCall", () => {
    it("returns false when no active call", () => {
      expect(store.isInCall).toBe(false);
    });

    it("returns true for connecting status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.connecting }));
      expect(store.isInCall).toBe(true);
    });

    it("returns true for connected status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.connected }));
      expect(store.isInCall).toBe(true);
    });

    it("returns true for ringing status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.ringing }));
      expect(store.isInCall).toBe(true);
    });

    it("returns false for idle status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.idle }));
      expect(store.isInCall).toBe(false);
    });

    it("returns false for ended status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.ended }));
      expect(store.isInCall).toBe(false);
    });

    it("returns false for failed status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.failed }));
      expect(store.isInCall).toBe(false);
    });
  });

  describe("hasLiveCall", () => {
    // On Android an incoming call rings through Telecom and the CallInfo is
    // only written when the user answers, so `isInCall` is false for the
    // whole ring. Re-entry guards need a signal that covers that window or a
    // second call takes the single slot and orphans the one that is ringing
    // (#1183).

    it("returns false when nothing holds the slot", () => {
      expect(store.hasLiveCall).toBe(false);
    });

    it("returns true while an SDK call exists with no CallInfo yet", () => {
      store.setMatrixCall({ callId: "c1", state: "ringing" });
      expect(store.isInCall).toBe(false);
      expect(store.hasLiveCall).toBe(true);
    });

    it("returns true whenever isInCall is true", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.connected }));
      expect(store.hasLiveCall).toBe(true);
    });

    it("keeps reporting a live call until told the SDK object changed", () => {
      // `state` is a plain field on the SDK object, not a reactive one. This
      // pins the consequence so nobody removes touchMatrixCall believing the
      // `state` read is enough on its own.
      const sdkCall = { callId: "c1", state: "ringing" };
      store.setMatrixCall(sdkCall);
      expect(store.hasLiveCall).toBe(true);

      sdkCall.state = "ended"; // exactly what the SDK does on terminate()
      expect(store.hasLiveCall).toBe(true); // cached — nothing triggered

      store.touchMatrixCall();
      expect(store.hasLiveCall).toBe(false);
    });

    it("ignores an SDK call the SDK has already ended", () => {
      // clearCall nulls the slot on every normal path; a teardown that
      // failed must not lock the user out of calling forever.
      store.setMatrixCall({ callId: "c1", state: "ended" });
      expect(store.hasLiveCall).toBe(false);
    });

    it("returns false again after clearCall", () => {
      store.setMatrixCall({ callId: "c1", state: "ringing" });
      store.clearCall();
      expect(store.hasLiveCall).toBe(false);
    });
  });

  describe("isRinging", () => {
    it("returns true for ringing status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.ringing }));
      expect(store.isRinging).toBe(true);
    });

    it("returns true for incoming status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.incoming }));
      expect(store.isRinging).toBe(true);
    });

    it("returns false for connected status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.connected }));
      expect(store.isRinging).toBe(false);
    });

    it("returns false when no call", () => {
      expect(store.isRinging).toBe(false);
    });
  });

  // ─── startTimer / stopTimer ───────────────────────────────────

  describe("startTimer / stopTimer", () => {
    it("increments callTimer every second", () => {
      store.startTimer();
      expect(store.callTimer).toBe(0);
      vi.advanceTimersByTime(3000);
      expect(store.callTimer).toBe(3);
    });

    it("stopTimer halts the timer", () => {
      store.startTimer();
      vi.advanceTimersByTime(2000);
      store.stopTimer();
      vi.advanceTimersByTime(2000);
      expect(store.callTimer).toBe(2); // stopped at 2
    });

    it("startTimer resets counter to 0", () => {
      store.startTimer();
      vi.advanceTimersByTime(5000);
      store.startTimer(); // restart
      expect(store.callTimer).toBe(0);
    });
  });

  // ─── scheduleClearCall / cancelScheduledClear ─────────────────

  describe("scheduleClearCall / cancelScheduledClear", () => {
    it("clears the call after delay", () => {
      store.setActiveCall(makeCallInfo());
      store.scheduleClearCall(3000);
      expect(store.activeCall).not.toBeNull();
      vi.advanceTimersByTime(3000);
      expect(store.activeCall).toBeNull();
    });

    // Regression: a dial that crossed an incoming call took the slot within the
    // ended call's clear window; the clear then stripped the new call's
    // listeners and its Telecom connection stayed DIALING for 30 minutes.
    it("leaves a newer call in the slot alone", () => {
      const removeAllListeners = vi.fn();
      store.setMatrixCall({ callId: "old", state: "ended" });
      store.scheduleClearCall(1500);
      store.setMatrixCall({ callId: "new", state: "invite_sent", removeAllListeners });
      vi.advanceTimersByTime(1500);
      expect(store.matrixCall?.callId).toBe("new");
      expect(removeAllListeners).not.toHaveBeenCalled();
    });

    it("cancelScheduledClear prevents the clear", () => {
      store.setActiveCall(makeCallInfo());
      store.scheduleClearCall(3000);
      store.cancelScheduledClear();
      vi.advanceTimersByTime(5000);
      expect(store.activeCall).not.toBeNull();
    });

    it("scheduling again cancels previous schedule", () => {
      store.setActiveCall(makeCallInfo());
      store.scheduleClearCall(1000);
      store.scheduleClearCall(5000); // replaces previous
      vi.advanceTimersByTime(2000);
      expect(store.activeCall).not.toBeNull(); // first didn't fire
      vi.advanceTimersByTime(3000);
      expect(store.activeCall).toBeNull(); // second fired
    });
  });

  // ─── addHistoryEntry ──────────────────────────────────────────

  describe("addHistoryEntry", () => {
    it("prepends entry to history", () => {
      const e1 = makeHistoryEntry({ id: "h1" });
      const e2 = makeHistoryEntry({ id: "h2" });
      store.addHistoryEntry(e1);
      store.addHistoryEntry(e2);
      expect(store.history[0].id).toBe("h2");
      expect(store.history[1].id).toBe("h1");
    });

    it("starts with empty history", () => {
      expect(store.history).toHaveLength(0);
    });
  });

  // ─── updateStatus ─────────────────────────────────────────────

  describe("updateStatus", () => {
    it("updates active call status", () => {
      store.setActiveCall(makeCallInfo({ status: CallStatus.connecting }));
      store.updateStatus(CallStatus.connected);
      expect(store.activeCall!.status).toBe(CallStatus.connected);
    });

    it("does nothing when no active call", () => {
      store.updateStatus(CallStatus.connected);
      expect(store.activeCall).toBeNull();
    });
  });
});
