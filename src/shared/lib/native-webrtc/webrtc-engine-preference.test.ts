// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getWebRTCEngine,
  setWebRTCEngine,
  isNativeWebRTCEngineEnabled,
  WEBRTC_ENGINE_LS_KEY,
} from "./webrtc-engine-preference";
import { APP_NAME } from "@/shared/config";

const storageKey = `${APP_NAME}:${WEBRTC_ENGINE_LS_KEY}`;

describe("webrtc-engine-preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the native engine when nothing is stored", () => {
    expect(getWebRTCEngine()).toBe("native");
    expect(isNativeWebRTCEngineEnabled()).toBe(true);
  });

  it("round-trips the webview engine", () => {
    setWebRTCEngine("webview");

    expect(getWebRTCEngine()).toBe("webview");
    expect(isNativeWebRTCEngineEnabled()).toBe(false);
  });

  it("round-trips back to native", () => {
    setWebRTCEngine("webview");
    setWebRTCEngine("native");

    expect(getWebRTCEngine()).toBe("native");
    expect(isNativeWebRTCEngineEnabled()).toBe(true);
  });

  it("falls back to native when the stored value is not a known engine", () => {
    window.localStorage.setItem(storageKey, JSON.stringify("quantum"));

    expect(getWebRTCEngine()).toBe("native");
  });

  it("falls back to native when the stored value is corrupt JSON", () => {
    window.localStorage.setItem(storageKey, "{not json");

    expect(getWebRTCEngine()).toBe("native");
  });

  it("falls back to native when storage reads throw (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(getWebRTCEngine()).toBe("native");
  });

  it("does not throw when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => setWebRTCEngine("webview")).not.toThrow();
  });
});
