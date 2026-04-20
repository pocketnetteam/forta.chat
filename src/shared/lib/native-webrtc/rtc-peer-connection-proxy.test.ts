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
            async (_event: string, _handler: unknown): Promise<PluginListenerHandle> => ({
              remove: async () => {},
            })
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
