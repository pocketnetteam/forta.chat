/**
 * Tests for the NativeRTCPeerConnection proxy.
 *
 * Focus areas (Session 02 — call drop fixes):
 * 1. restartIce() must call native bridge, NOT be a no-op.
 * 2. getStats() must return real metrics from native, NOT an empty Map.
 * 3. _syncLocalStreamIds must allow re-syncing on renegotiation
 *    (video upgrade / glare) — stream.id must be rewritable.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";

// ---------------------------------------------------------------------------
// Mock Capacitor bridge — captures native method calls so tests can assert.
// ---------------------------------------------------------------------------

type BridgeMethod = Mock<(...args: unknown[]) => Promise<unknown>>;
const bridgeMethods: Record<string, BridgeMethod> = {};

function getBridgeMethod(name: string): BridgeMethod {
  if (!bridgeMethods[name]) {
    bridgeMethods[name] = vi.fn().mockResolvedValue({}) as BridgeMethod;
  }
  return bridgeMethods[name];
}

// Capture native event handlers so tests can simulate native callbacks
// (e.g. fire onIceConnectionStateChange to drive the proxy through state transitions).
type NativeListener = (data: unknown) => void;
const nativeListeners: Record<string, Set<NativeListener>> = {};

function fireNativeEvent(event: string, data: unknown): void {
  nativeListeners[event]?.forEach((handler) => handler(data));
}

function clearNativeListeners(): void {
  for (const k of Object.keys(nativeListeners)) {
    nativeListeners[k].clear();
  }
}

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
  registerPlugin: () =>
    new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "addListener") {
          return vi.fn().mockImplementation(
            async (event: string, handler: NativeListener): Promise<PluginListenerHandle> => {
              if (!nativeListeners[event]) nativeListeners[event] = new Set();
              nativeListeners[event].add(handler);
              return {
                remove: async () => {
                  nativeListeners[event]?.delete(handler);
                },
              };
            }
          );
        }
        return getBridgeMethod(prop);
      },
    }),
}));

// Import after mocking. Module-level capture of window.RTCPeerConnection
// happens on import; installNativeWebRTCProxy overrides it.
import {
  installNativeWebRTCProxy,
  uninstallNativeWebRTCProxy,
} from "./rtc-peer-connection-proxy";

// Helper: wait a microtask tick so async init of NativeRTCPeerConnection completes.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("NativeRTCPeerConnection proxy", () => {
  beforeEach(() => {
    for (const k of Object.keys(bridgeMethods)) {
      bridgeMethods[k].mockClear();
    }
    clearNativeListeners();
    installNativeWebRTCProxy();
  });

  afterEach(() => {
    uninstallNativeWebRTCProxy();
  });

  describe("STUN fallback injection", () => {
    it("injects default Google STUN when config provides no iceServers", async () => {
      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      const createPc = getBridgeMethod("createPeerConnection");
      expect(createPc).toHaveBeenCalledOnce();
      const arg = createPc.mock.calls[0]?.[0] as
        | { iceServers?: Array<{ urls: string | string[] }> }
        | undefined;
      const urls = (arg?.iceServers ?? [])
        .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
      expect(urls.some((u) => /^stun:stun\.l\.google\.com/.test(u))).toBe(true);

      pc.close();
    });

    it("injects default STUN when iceServers is an empty array", async () => {
      const pc = new window.RTCPeerConnection({ iceServers: [] });
      await tick();
      await tick();

      const createPc = getBridgeMethod("createPeerConnection");
      const arg = createPc.mock.calls[0]?.[0] as
        | { iceServers?: Array<{ urls: string | string[] }> }
        | undefined;
      expect((arg?.iceServers ?? []).length).toBeGreaterThan(0);

      pc.close();
    });

    it("preserves caller-provided STUN/TURN and does not inject fallback", async () => {
      const pc = new window.RTCPeerConnection({
        iceServers: [
          { urls: "turn:my-turn.example.com:3478", username: "u", credential: "p" },
        ],
      });
      await tick();
      await tick();

      const createPc = getBridgeMethod("createPeerConnection");
      const arg = createPc.mock.calls[0]?.[0] as
        | { iceServers?: Array<{ urls: string | string[]; username?: string }> }
        | undefined;
      const servers = arg?.iceServers ?? [];
      // Caller server preserved, no google fallback appended.
      expect(servers).toHaveLength(1);
      expect(servers[0].urls).toBe("turn:my-turn.example.com:3478");
      expect(servers[0].username).toBe("u");

      pc.close();
    });
  });

  describe("restartIce()", () => {
    it("calls NativeWebRTC.restartIce on the native bridge, not a no-op", async () => {
      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      pc.restartIce();
      await tick();
      await tick();

      const restartIce = getBridgeMethod("restartIce");
      expect(restartIce).toHaveBeenCalledOnce();
      // Must carry peerId so native can route to the correct connection.
      const callArg = restartIce.mock.calls[0]?.[0] as { peerId?: string } | undefined;
      expect(callArg?.peerId).toBeDefined();
      expect(typeof callArg?.peerId).toBe("string");

      pc.close();
    });
  });

  describe("getStats()", () => {
    it("returns an RTCStatsReport populated from native bridge report", async () => {
      const report = {
        "outbound-rtp-audio-0": {
          id: "outbound-rtp-audio-0",
          type: "outbound-rtp",
          kind: "audio",
          bytesSent: 12345,
          packetsSent: 42,
        },
        "inbound-rtp-audio-0": {
          id: "inbound-rtp-audio-0",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 6789,
          packetsReceived: 21,
        },
      };
      getBridgeMethod("getStats").mockResolvedValueOnce({ report });

      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      const stats = await pc.getStats();

      expect(stats).toBeInstanceOf(Map);
      expect(stats.size).toBeGreaterThan(0);
      const outbound = stats.get("outbound-rtp-audio-0") as Record<string, unknown> | undefined;
      expect(outbound?.bytesSent).toBe(12345);
      const inbound = stats.get("inbound-rtp-audio-0") as Record<string, unknown> | undefined;
      expect(inbound?.bytesReceived).toBe(6789);

      const getStats = getBridgeMethod("getStats");
      expect(getStats).toHaveBeenCalledOnce();
      const callArg = getStats.mock.calls[0]?.[0] as { peerId?: string } | undefined;
      expect(callArg?.peerId).toBeDefined();

      pc.close();
    });

    it("returns empty Map and does not throw when native bridge rejects", async () => {
      getBridgeMethod("getStats").mockRejectedValueOnce(new Error("native failure"));

      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      const stats = await pc.getStats();
      expect(stats).toBeInstanceOf(Map);
      expect(stats.size).toBe(0);

      pc.close();
    });
  });

  describe("ICE watchdog (Session 03)", () => {
    // These tests use fake timers to drive disconnected/failed → restartIce
    // and the 20s dead-connection escalation.
    let restartIceMock: BridgeMethod;
    let createPcMock: BridgeMethod;

    async function newPcAndPeerId(): Promise<{
      pc: RTCPeerConnection;
      peerId: string;
    }> {
      const pc = new window.RTCPeerConnection();
      // Flush microtasks so _initNative completes (createPeerConnection +
      // addListener calls) under fake timers.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      const arg = createPcMock.mock.calls.at(-1)?.[0] as { peerId: string };
      return { pc, peerId: arg.peerId };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      restartIceMock = getBridgeMethod("restartIce");
      createPcMock = getBridgeMethod("createPeerConnection");
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("calls restartIce after 10s of sustained disconnected state", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "disconnected",
      });

      // Just before 10s — no restart yet.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(restartIceMock).not.toHaveBeenCalled();

      // After 10s — restart must fire.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(restartIceMock).toHaveBeenCalledOnce();

      pc.close();
    });

    it("does NOT call restartIce when disconnected recovers to connected within 10s", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "disconnected",
      });
      await vi.advanceTimersByTimeAsync(5_000);

      // Recover before timeout.
      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "connected",
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(restartIceMock).not.toHaveBeenCalled();

      pc.close();
    });

    it("calls restartIce immediately when ICE state transitions to failed", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "failed",
      });
      // Allow microtasks to drain so restartIce delegate fires.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);

      expect(restartIceMock).toHaveBeenCalledOnce();

      pc.close();
    });

    it("dispatches 'connectiondead' event 20s after failed without recovery", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      const deadHandler = vi.fn();
      pc.addEventListener("connectiondead", deadHandler);

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "failed",
      });
      // Restart fires, ICE remains failed (we never simulate recovery).
      await vi.advanceTimersByTimeAsync(15_000);
      expect(deadHandler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(deadHandler).toHaveBeenCalledOnce();

      pc.close();
    });

    it("does NOT dispatch 'connectiondead' if ICE recovers after failed", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      const deadHandler = vi.fn();
      pc.addEventListener("connectiondead", deadHandler);

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "failed",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "connected",
      });
      await vi.advanceTimersByTimeAsync(25_000);

      expect(deadHandler).not.toHaveBeenCalled();

      pc.close();
    });

    it("clears watchdog timers on close so no late restart fires", async () => {
      const { pc, peerId } = await newPcAndPeerId();

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "disconnected",
      });

      pc.close();
      restartIceMock.mockClear();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(restartIceMock).not.toHaveBeenCalled();
    });

    it("debounces back-to-back restartIce calls within 3s", async () => {
      const { pc } = await newPcAndPeerId();

      pc.restartIce();
      pc.restartIce();
      pc.restartIce();
      await vi.advanceTimersByTimeAsync(50);

      // Three callers, one native call.
      expect(restartIceMock).toHaveBeenCalledTimes(1);

      // After the debounce window expires, a fresh request goes through.
      await vi.advanceTimersByTimeAsync(3_500);
      pc.restartIce();
      await vi.advanceTimersByTimeAsync(50);
      expect(restartIceMock).toHaveBeenCalledTimes(2);

      pc.close();
    });

    it("escalates sustained disconnected to connectiondead at ~30s (10s wait + 20s dead)", async () => {
      const { pc, peerId } = await newPcAndPeerId();
      const deadHandler = vi.fn();
      pc.addEventListener("connectiondead", deadHandler);

      fireNativeEvent("onIceConnectionStateChange", {
        peerId,
        state: "disconnected",
      });

      // 10s tick → restartIce, dead timer armed, but no event yet.
      await vi.advanceTimersByTimeAsync(10_500);
      expect(restartIceMock).toHaveBeenCalledOnce();
      expect(deadHandler).not.toHaveBeenCalled();

      // No recovery — fire connectiondead 20s later.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(deadHandler).toHaveBeenCalledOnce();

      pc.close();
    });

    it("does NOT re-arm the dead timer when ICE flaps between failed and disconnected", async () => {
      const { pc, peerId } = await newPcAndPeerId();
      const deadHandler = vi.fn();
      pc.addEventListener("connectiondead", deadHandler);

      // Initial failed → dead timer armed.
      fireNativeEvent("onIceConnectionStateChange", { peerId, state: "failed" });
      await vi.advanceTimersByTimeAsync(0);

      // Flap to disconnected then failed every few seconds. If the dead
      // timer were re-armed each time, the 20s deadline would never fire.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(4_000);
        fireNativeEvent("onIceConnectionStateChange", {
          peerId,
          state: i % 2 === 0 ? "disconnected" : "failed",
        });
      }

      // Total elapsed: 0 + 4 + 4 + 4 + 4 = 16s; dead timer was armed at 0.
      // Advance past 20s to ensure it fires once.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deadHandler).toHaveBeenCalledOnce();

      pc.close();
    });
  });

  describe("_syncLocalStreamIds (renegotiation)", () => {
    it("updates local stream.id on first createOffer to match native SDP msid", async () => {
      const sdpWithMsid =
        "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=msid:native-stream-A native-track-A\r\n";
      getBridgeMethod("createOffer").mockResolvedValueOnce({
        sdp: sdpWithMsid,
        type: "offer",
      });

      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      const dummyTrack = { kind: "audio", enabled: true } as MediaStreamTrack;
      const localStream = new MediaStream();
      // addTrack registers the stream internally for _syncLocalStreamIds
      pc.addTrack(dummyTrack, localStream);

      const originalId = localStream.id;
      expect(originalId).not.toBe("native-stream-A");

      await pc.createOffer();

      expect(localStream.id).toBe("native-stream-A");

      pc.close();
    });

    it("allows stream.id to be updated again on renegotiation (video upgrade / glare)", async () => {
      const sdpOffer1 =
        "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=msid:native-stream-v1 track-v1\r\n";
      const sdpOffer2 =
        "v=0\r\no=- 1 3 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=msid:native-stream-v2 track-v2\r\n";

      const createOffer = getBridgeMethod("createOffer");
      createOffer
        .mockResolvedValueOnce({ sdp: sdpOffer1, type: "offer" })
        .mockResolvedValueOnce({ sdp: sdpOffer2, type: "offer" });

      const pc = new window.RTCPeerConnection();
      await tick();
      await tick();

      const dummyTrack = { kind: "audio", enabled: true } as MediaStreamTrack;
      const localStream = new MediaStream();
      pc.addTrack(dummyTrack, localStream);

      await pc.createOffer();
      expect(localStream.id).toBe("native-stream-v1");

      // Simulate renegotiation — SDK calls createOffer again with new msid.
      await pc.createOffer();
      // This is the bug fix: writable:false previously prevented rewrite,
      // leaving stream.id stuck at "native-stream-v1".
      expect(localStream.id).toBe("native-stream-v2");

      pc.close();
    });
  });
});
