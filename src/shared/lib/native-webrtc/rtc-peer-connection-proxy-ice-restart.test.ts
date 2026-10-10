// @vitest-environment happy-dom
/**
 * Regression: on Android an ICE restart never reached the peer. `restartIce()` marks the native
 * connection, libwebrtc then reports renegotiation-needed, and NativeWebRTCManager suppresses that
 * event (it also fires for our own track management). With no negotiationneeded the SDK never
 * created the restart offer, so the network-change handler and both ICE watchdogs did nothing: a
 * call that lost Wi-Fi mid-call could only be saved by the other side (Samsung, `cell-wifioff1`:
 * `restartIce: invoked PeerConnection.restartIce()` right after `onRenegotiationNeeded (suppressed)`,
 * no m.call.negotiate).
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
  };
}

async function connection(
  { connected = true }: { connected?: boolean } = {},
): Promise<{ pc: RTCPeerConnection; peerId: string; offersNeeded: () => number }> {
  const pc = new window.RTCPeerConnection();
  await flush();
  const peerId = (bridge("createPeerConnection").mock.calls.at(-1)?.[0] as { peerId: string }).peerId;
  if (connected) fireNative("onIceConnectionStateChange", { peerId, state: "connected" });
  let count = 0;
  pc.addEventListener("negotiationneeded", () => { count++; });
  return { pc, peerId, offersNeeded: () => count };
}

describe("NativeRTCPeerConnection — an ICE restart produces a restart offer", () => {
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

  it("fires negotiationneeded once the native restart is done, when signaling is stable", async () => {
    const { pc, offersNeeded } = await connection();

    pc.restartIce();
    await flush();

    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("waits for stable signaling when the restart comes in the middle of an offer exchange", async () => {
    const { pc, peerId, offersNeeded } = await connection();
    fireNative("onSignalingStateChange", { peerId, state: "have-remote-offer" });

    pc.restartIce();
    await flush();
    expect(offersNeeded()).toBe(0);

    fireNative("onSignalingStateChange", { peerId, state: "stable" });
    await flush();
    expect(offersNeeded()).toBe(1);

    fireNative("onSignalingStateChange", { peerId, state: "have-local-offer" });
    fireNative("onSignalingStateChange", { peerId, state: "stable" });
    await flush();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("fires nothing when the native restart fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bridge("restartIce").mockRejectedValueOnce(new Error("restartIce failed (peer not found)"));
    const { pc, offersNeeded } = await connection();

    pc.restartIce();
    await flush();

    expect(offersNeeded()).toBe(0);
    pc.close();
  });

  it("fires nothing for a restart still waiting on signaling when the connection closes", async () => {
    const { pc, peerId, offersNeeded } = await connection();
    fireNative("onSignalingStateChange", { peerId, state: "have-local-offer" });
    pc.restartIce();
    await flush();

    pc.close();
    fireNative("onSignalingStateChange", { peerId, state: "stable" });
    await flush();

    expect(offersNeeded()).toBe(0);
  });

  it("asks for no restart offer before ICE has ever connected, as before", async () => {
    const { pc, peerId, offersNeeded } = await connection({ connected: false });
    fireNative("onIceConnectionStateChange", { peerId, state: "checking" });

    pc.restartIce();
    await flush();
    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(0);

    fireNative("onIceConnectionStateChange", { peerId, state: "connected" });
    await flush();
    expect(offersNeeded()).toBe(0);
    pc.close();
  });

  it("sends the restart offer after the SDK's own offer exchange completes", async () => {
    const { pc, offersNeeded } = await connection();
    await pc.setLocalDescription({ type: "offer", sdp: "v=0" });
    expect(pc.signalingState).toBe("have-local-offer");

    pc.restartIce();
    await flush();
    expect(offersNeeded()).toBe(0);

    await pc.setRemoteDescription({ type: "answer", sdp: "v=0" });
    await flush();
    expect(pc.signalingState).toBe("stable");
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("collapses back-to-back restarts into one offer", async () => {
    const { pc, offersNeeded } = await connection();

    pc.restartIce();
    pc.restartIce();
    await flush();

    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });
});

/**
 * Regression for the fix above: with no network at all, the SDK fails to send the restart offer at once
 * (the WebView rejects the request) and ends the call. The SDK asks for a restart 2 s after ICE goes
 * disconnected, so a Wi-Fi drop with no other network ended the call within seconds, where before it
 * could wait up to 30 s for the network to come back.
 */
describe("NativeRTCPeerConnection — the restart offer waits for the network", () => {
  let online = true;

  beforeEach(() => {
    for (const m of Object.values(bridgeMethods)) m.mockReset().mockResolvedValue({});
    for (const s of Object.values(nativeListeners)) s.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    installNativeWebRTCProxy();
  });

  afterEach(() => {
    uninstallNativeWebRTCProxy();
    vi.restoreAllMocks();
  });

  const goOnline = (): void => {
    online = true;
    window.dispatchEvent(new Event("online"));
  };

  it("holds the offer while the device is offline and sends it once the network is back", async () => {
    const { pc, offersNeeded } = await connection();
    online = false;

    pc.restartIce();
    await flush();
    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(0);

    goOnline();
    await flush();
    expect(offersNeeded()).toBe(1);

    goOnline();
    await flush();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("sends nothing when the connection closes before the network is back", async () => {
    const { pc, offersNeeded } = await connection();
    online = false;
    pc.restartIce();
    await flush();

    pc.close();
    goOnline();
    await flush();

    expect(offersNeeded()).toBe(0);
  });

  it("sends one offer when the network-change handler restarts ICE as the network comes back", async () => {
    // Samsung, offline-restart1: the handler's restartIce ran a second native restart while the held offer
    // went out on `online`, and its completion fired a second offer. The web applied both, the phone
    // failed to apply the first answer ("Called in wrong state: stable").
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { pc, offersNeeded } = await connection();
    online = false;
    pc.restartIce();
    await flush();

    now += 8_000;
    online = true;
    pc.restartIce();
    window.dispatchEvent(new Event("online"));
    await flush();

    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });

  it("treats a restart right after the held offer went out as the same restart", async () => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { pc, offersNeeded } = await connection();
    online = false;
    pc.restartIce();
    await flush();

    now += 20_000;
    goOnline();
    await flush();
    expect(offersNeeded()).toBe(1);

    // The network-change handler reacts to the same reconnect.
    now += 500;
    pc.restartIce();
    await flush();

    expect(bridge("restartIce")).toHaveBeenCalledOnce();
    expect(offersNeeded()).toBe(1);
    pc.close();
  });
});
