// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeCallHangupContext,
  ensureCallHangupContextProvider,
  installCallHangupContextProvider,
} from "./call-hangup-context";

const matrixService = {
  client: null as null | { baseUrl: string; getAccessToken(): string | null; getDeviceId(): string | null },
};
const callStore = { matrixCall: null as null | { callId: string; roomId?: string } };

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => matrixService }));
vi.mock("@/entities/call", () => ({ useCallStore: () => callStore }));

const source = {
  call: { callId: "call-1", roomId: "!room:matrix.pocketnet.app" },
  baseUrl: "https://matrix.pocketnet.app",
  accessToken: "syt_token",
  deviceId: "DEVICE",
};

describe("encodeCallHangupContext", () => {
  // Android sends m.call.hangup itself when a swipe destroys the WebView mid-call
  // (Samsung ↔ Pixel bench 2026-09-17: the peer sat in a silent call for 29 s).
  it("encodes what native needs for the SDK's hangup of this call", () => {
    const params = new URLSearchParams(encodeCallHangupContext("call-1", source)!);
    expect(Object.fromEntries(params)).toEqual({
      callId: "call-1",
      roomId: "!room:matrix.pocketnet.app",
      partyId: "DEVICE",
      baseUrl: "https://matrix.pocketnet.app",
      accessToken: "syt_token",
    });
  });

  it("uses only characters that stay intact inside the JSON string evaluateJavascript returns", () => {
    const encoded = encodeCallHangupContext("call-1", { ...source, accessToken: 'a"b\\c d' })!;
    expect(encoded).not.toMatch(/["\\ ]/);
  });

  it("returns null for another call, a call without a room or a client without credentials", () => {
    expect(encodeCallHangupContext("call-2", source)).toBeNull();
    expect(encodeCallHangupContext("call-1", { ...source, call: null })).toBeNull();
    expect(encodeCallHangupContext("call-1", { ...source, call: { callId: "call-1" } })).toBeNull();
    expect(encodeCallHangupContext("call-1", { ...source, accessToken: null })).toBeNull();
    expect(encodeCallHangupContext("call-1", { ...source, deviceId: undefined })).toBeNull();
    expect(encodeCallHangupContext("call-1", { ...source, baseUrl: "" })).toBeNull();
  });
});

describe("installCallHangupContextProvider", () => {
  afterEach(() => {
    delete window.__fortaCallHangupContext;
    matrixService.client = null;
    callStore.matrixCall = null;
  });

  it("answers native from the live client and the store's call", () => {
    installCallHangupContextProvider();
    matrixService.client = {
      baseUrl: "https://matrix.pocketnet.app",
      getAccessToken: () => "syt_token",
      getDeviceId: () => "DEVICE",
    };
    callStore.matrixCall = { callId: "call-1", roomId: "!room:matrix.pocketnet.app" };

    const params = new URLSearchParams(window.__fortaCallHangupContext!("call-1")!);
    expect(params.get("partyId")).toBe("DEVICE");
    expect(params.get("roomId")).toBe("!room:matrix.pocketnet.app");
    // Whether the hangup goes through Tor is decided natively (tor2): the page's
    // proxy is the one configured at login and goes stale mid-session.
    expect(params.get("viaTorProxy")).toBeNull();
  });

  it("is installed by ensure() when a call starts and keeps the one already there", () => {
    // The boot-time install can still be pending when a dial lands right after a
    // cold start — that call had no hangup context in `hswipe1`.
    ensureCallHangupContextProvider();
    expect(typeof window.__fortaCallHangupContext).toBe("function");

    const installed = window.__fortaCallHangupContext;
    ensureCallHangupContextProvider();
    expect(window.__fortaCallHangupContext).toBe(installed);
  });

  it("returns null while there is no client or call", () => {
    installCallHangupContextProvider();
    expect(window.__fortaCallHangupContext!("call-1")).toBeNull();
  });
});
