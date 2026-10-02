// @vitest-environment happy-dom
/**
 * Regression: on Android an ICE restart from both ends at once never completed. libwebrtc's native API has no
 * implicit rollback, unlike a browser: the polite side's setRemoteDescription(offer) while its own offer was out
 * failed with "Called in wrong state: have-local-offer", the impolite web ignored the phone's offer, and both ends
 * stayed in have-local-offer. The SDK restarts ICE 2 s after a disconnect on both ends, so a network change during
 * an incoming Android call collides like this (Samsung `glare-in1` call 2: `setRemoteDescription failed … Called in
 * wrong state: have-local-offer`, `ignoring colliding negotiate event because we're impolite` on the web).
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

const offer = (ufrag: string): string =>
  ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=ice-ufrag:${ufrag}`, "a=mid:0", ""]
    .join("\r\n");

async function connection(): Promise<{ pc: RTCPeerConnection; peerId: string; offersNeeded: () => number }> {
  const pc = new window.RTCPeerConnection();
  await flush();
  const peerId = (bridge("createPeerConnection").mock.calls.at(-1)?.[0] as { peerId: string }).peerId;
  fireNative("onIceConnectionStateChange", { peerId, state: "connected" });
  let count = 0;
  pc.addEventListener("negotiationneeded", () => { count++; });
  return { pc, peerId, offersNeeded: () => count };
}

/** Bridge calls in order, as "method:type". */
const descriptionCalls = (): string[] => {
  const calls: Array<[string, number, string]> = [];
  for (const method of ["setLocalDescription", "setRemoteDescription"]) {
    bridge(method).mock.calls.forEach((args, i) => {
      calls.push([method, bridge(method).mock.invocationCallOrder[i], (args[0] as { type: string }).type]);
    });
  }
  return calls.sort((a, b) => a[1] - b[1]).map(([method, , type]) => `${method}:${type}`);
};

describe("NativeRTCPeerConnection — a peer's offer while our offer is out rolls ours back", () => {
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

  it("rolls back our offer before applying the peer's, and ends in have-remote-offer", async () => {
    const { pc } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });

    await pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") });

    expect(descriptionCalls()).toEqual(["setLocalDescription:offer", "setLocalDescription:rollback", "setRemoteDescription:offer"]);
    expect(pc.signalingState).toBe("have-remote-offer");
    pc.close();
  });

  it("waits for our offer still being applied before deciding to roll it back", async () => {
    const { pc } = await connection();
    let finishLocal!: () => void;
    bridge("setLocalDescription").mockImplementationOnce(() => new Promise((r) => { finishLocal = () => r({}); }));

    const local = pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });
    await flush();
    const remote = pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") });
    await flush();
    expect(bridge("setRemoteDescription")).not.toHaveBeenCalled();

    finishLocal();
    await local;
    await remote;

    expect(descriptionCalls()).toEqual(["setLocalDescription:offer", "setLocalDescription:rollback", "setRemoteDescription:offer"]);
    pc.close();
  });

  it("puts back the local description the rolled-back offer replaced", async () => {
    const { pc } = await connection();
    await pc.setRemoteDescription({ type: "offer", sdp: offer("PEER1") });
    await pc.setLocalDescription({ type: "answer", sdp: offer("ANSWER1") });
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });

    await pc.setRemoteDescription({ type: "offer", sdp: offer("PEER2") });

    expect(pc.localDescription?.sdp).toContain("a=ice-ufrag:ANSWER1");
    pc.close();
  });

  it("does not roll back in stable or for an answer", async () => {
    const { pc } = await connection();
    await pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") });
    await pc.setLocalDescription({ type: "answer", sdp: offer("MINE") });
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE2") });
    await pc.setRemoteDescription({ type: "answer", sdp: offer("PEER2") });

    expect(descriptionCalls()).not.toContain("setLocalDescription:rollback");
    pc.close();
  });

  it("sends a restart offer that was waiting for stable only after the peer's offer is answered", async () => {
    const { pc, peerId, offersNeeded } = await connection();
    // libwebrtc reports each transition itself, before the call that caused it resolves.
    bridge("setLocalDescription").mockImplementation(async (args: unknown) => {
      if ((args as { type: string }).type === "rollback") fireNative("onSignalingStateChange", { peerId, state: "stable" });
      return {};
    });
    bridge("setRemoteDescription").mockImplementation(async () => {
      fireNative("onSignalingStateChange", { peerId, state: "have-remote-offer" });
      return {};
    });
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });
    pc.restartIce();
    await flush();
    expect(offersNeeded()).toBe(0);

    await pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") });
    await flush();
    expect(offersNeeded()).toBe(0);

    await pc.setLocalDescription({ type: "answer", sdp: offer("ANSWER") });
    await flush();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("does not let a restart asked for during the rollback go out before the peer's offer is applied", async () => {
    const { pc, peerId, offersNeeded } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });
    let finishRemote!: () => void;
    bridge("setRemoteDescription").mockImplementationOnce(() => new Promise((r) => { finishRemote = () => r({}); }));

    const remote = pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") });
    await flush();
    expect(pc.signalingState).toBe("stable");
    pc.restartIce();
    await flush();
    expect(offersNeeded()).toBe(0);

    finishRemote();
    await remote;
    await flush();
    expect(offersNeeded()).toBe(0);
    fireNative("onSignalingStateChange", { peerId, state: "have-remote-offer" });
    await pc.setLocalDescription({ type: "answer", sdp: offer("ANSWER") });
    await flush();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("still sends a waiting restart offer when the peer's offer fails to apply after the rollback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pc, offersNeeded } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });
    pc.restartIce();
    await flush();
    bridge("setRemoteDescription").mockRejectedValueOnce(new Error("setRemoteDescription failed"));

    await expect(pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") })).rejects.toThrow();
    await flush();

    expect(pc.signalingState).toBe("stable");
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("rolls back once when the peer's offer arrives twice at the same moment", async () => {
    const { pc } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: offer("MINE") });

    await Promise.all([
      pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") }),
      pc.setRemoteDescription({ type: "offer", sdp: offer("PEER") }),
    ]);

    expect(descriptionCalls()).toEqual([
      "setLocalDescription:offer", "setLocalDescription:rollback", "setRemoteDescription:offer", "setRemoteDescription:offer",
    ]);
    pc.close();
  });
});
