// @vitest-environment happy-dom
/**
 * Regression: on Android the local ICE candidates gathered before the SDK sent its answer (or offer) never
 * reached the peer. The native SDP from createAnswer carries no candidates and the proxy's localDescription
 * stayed that SDP, while matrix-js-sdk reads localDescription as a browser's, which gains every gathered
 * candidate, and drops the candidates it had queued ("sendAnswer() discarding 6 candidates that will be sent
 * in answer"). Samsung over LTE through a VPN (`vpn-ice-in1` call 2): all six candidates were gathered before
 * the answer went out, the web got none, its ICE stayed "new", and the call failed after 15 s.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";

type BridgeMethod = Mock<(...args: unknown[]) => Promise<unknown>>;
const bridgeMethods: Record<string, BridgeMethod> = {};
function bridge(name: string): BridgeMethod {
  if (!bridgeMethods[name]) bridgeMethods[name] = vi.fn().mockResolvedValue({}) as BridgeMethod;
  return bridgeMethods[name];
}

type NativeListener = (data: unknown) => void;
const nativeListeners: Record<string, Set<NativeListener>> = {};
const fireNative = (event: string, data: unknown): void => nativeListeners[event]?.forEach((h) => h(data));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
  registerPlugin: () =>
    new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "addListener") {
          return vi.fn().mockImplementation(
            async (event: string, handler: NativeListener): Promise<PluginListenerHandle> => {
              (nativeListeners[event] ??= new Set()).add(handler);
              return { remove: async () => { nativeListeners[event]?.delete(handler); } };
            },
          );
        }
        return bridge(prop);
      },
    }),
}));

import { installNativeWebRTCProxy, uninstallNativeWebRTCProxy } from "./rtc-peer-connection-proxy";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

if (typeof globalThis.RTCSessionDescription === "undefined") {
  (globalThis as unknown as { RTCSessionDescription: unknown }).RTCSessionDescription = class {
    type: string;
    sdp: string;
    constructor(init: { type?: string; sdp?: string }) { this.type = init.type ?? "offer"; this.sdp = init.sdp ?? ""; }
    // The SDK sends invites and negotiate events as `localDescription.toJSON()`.
    toJSON(): { type: string; sdp: string } { return { type: this.type, sdp: this.sdp }; }
  };
}
// The proxy builds RTCIceCandidate objects; happy-dom has no such class.
if (typeof globalThis.RTCIceCandidate === "undefined") {
  (globalThis as unknown as { RTCIceCandidate: unknown }).RTCIceCandidate = class {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    constructor(init: RTCIceCandidateInit) {
      this.candidate = init.candidate ?? "";
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
    }
  };
}

const sdp = (ufrag: string): string =>
  ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    `a=ice-ufrag:${ufrag}`, "a=mid:0", "a=rtpmap:111 opus/48000/2", ""].join("\r\n");
const candidate = (n: number, ufrag: string): string =>
  `candidate:${n} 1 udp 2122260223 192.0.2.${n} 5000${n} typ host generation 0 ufrag ${ufrag} network-id 1`;

async function connection(): Promise<{ pc: RTCPeerConnection; peerId: string }> {
  const pc = new window.RTCPeerConnection();
  await flush();
  const peerId = (bridge("createPeerConnection").mock.calls.at(-1)?.[0] as { peerId: string }).peerId;
  return { pc, peerId };
}

const gathered = (peerId: string, n: number, ufrag: string): void =>
  fireNative("onIceCandidate", { peerId, candidate: candidate(n, ufrag), sdpMid: "0", sdpMLineIndex: 0 });

describe("NativeRTCPeerConnection — localDescription carries the gathered candidates", () => {
  beforeEach(() => {
    for (const m of Object.values(bridgeMethods)) m.mockReset().mockResolvedValue({});
    for (const s of Object.values(nativeListeners)) s.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    installNativeWebRTCProxy();
  });

  afterEach(() => {
    uninstallNativeWebRTCProxy();
    vi.restoreAllMocks();
  });

  it("puts the candidates gathered before the answer is sent into the answer", async () => {
    const { pc, peerId } = await connection();
    await pc.setLocalDescription({ type: "answer", sdp: sdp("AAAA") });

    gathered(peerId, 1, "AAAA");
    gathered(peerId, 2, "AAAA");

    expect(pc.localDescription?.type).toBe("answer");
    expect(pc.localDescription?.sdp).toContain(`a=${candidate(1, "AAAA")}\r\n`);
    expect(pc.localDescription?.sdp).toContain(`a=${candidate(2, "AAAA")}\r\n`);
    expect(pc.currentLocalDescription?.sdp).toBe(pc.localDescription?.sdp);
    pc.close();
  });

  it("puts them into an invite or negotiate event, which the SDK builds with toJSON()", async () => {
    const { pc, peerId } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: sdp("AAAA") });

    gathered(peerId, 1, "AAAA");

    expect(pc.localDescription?.toJSON()).toEqual({ type: "offer", sdp: expect.stringContaining(`a=${candidate(1, "AAAA")}\r\n`) });
    pc.close();
  });

  it("already has a candidate in localDescription when its icecandidate event fires", async () => {
    const { pc, peerId } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: sdp("AAAA") });
    const seen: boolean[] = [];
    pc.onicecandidate = () => {
      seen.push(pc.localDescription?.sdp.includes(candidate(1, "AAAA")) ?? false);
    };

    gathered(peerId, 1, "AAAA");

    expect(seen).toEqual([true]);
    pc.close();
  });

  it("leaves the candidates of the previous ICE generation out of a restart offer", async () => {
    const { pc, peerId } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: sdp("AAAA") });
    gathered(peerId, 1, "AAAA");

    await pc.setLocalDescription({ type: "offer", sdp: sdp("BBBB") });
    expect(pc.localDescription?.sdp).not.toContain("a=candidate:");

    gathered(peerId, 2, "BBBB");
    expect(pc.localDescription?.sdp).toContain(`a=${candidate(2, "BBBB")}`);
    expect(pc.localDescription?.sdp).not.toContain("ufrag AAAA");
    pc.close();
  });

  it("ignores candidates of another native connection", async () => {
    const { pc } = await connection();
    await pc.setLocalDescription({ type: "answer", sdp: sdp("AAAA") });

    gathered("pc_other", 1, "AAAA");

    expect(pc.localDescription?.sdp).toBe(sdp("AAAA"));
    pc.close();
  });
});
