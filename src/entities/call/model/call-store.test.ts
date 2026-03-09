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
