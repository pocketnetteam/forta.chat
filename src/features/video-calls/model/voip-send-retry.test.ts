/**
 * Regression: an ICE restart could not outlive a short network outage. The SDK ends the call as soon as
 * one send of the restart offer fails (`gotLocalOffer` → `signalling_timeout`) and gives up on candidates
 * after a few quick retries, while ICE itself waits 30 s. Samsung `wifioff-vpn2`: Wi-Fi went off, the
 * restart offer went out at once, the VPN needed longer to carry traffic, `PUT m.call.negotiate` failed
 * after 5 s and the call ended.
 *
 * Regression: the SDK fails the call on the first failed send of `m.call.answer`. iPhone XR 2026-09-24:
 * WebKit dropped the answer's PUT while the app switched to the CallKit screen
 * (`ConnectionError: fetch failed: Load failed`) and the call ended with `send_answer`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ANSWER_RETRY_POLICY, installVoipSendRetry, VOIP_SEND_RETRY_WINDOW_MS } from "./voip-send-retry";

class ConnectionError extends Error {
  get name(): string {
    return "ConnectionError";
  }
}

function fakeCall(results: Array<"ok" | Error>) {
  let ended = false;
  const send = vi.fn(async (_type: string, _content: Record<string, unknown>) => {
    const next = results.shift() ?? "ok";
    if (next !== "ok") throw next;
  });
  const call = {
    callId: "c1",
    sendVoipEvent: send,
    callHasEnded: () => ended,
  };
  return { call, send, end: () => { ended = true; } };
}

function deps(overrides: Partial<Parameters<typeof installVoipSendRetry>[1]> = {}) {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => { now += ms; },
    value: {
      now: () => now,
      sleep: vi.fn(async (ms: number) => { sleeps.push(ms); now += ms; }),
      isOnline: () => true,
      waitForOnline: vi.fn(async () => {}),
      ...overrides,
    },
  };
}

describe("installVoipSendRetry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("retries a restart offer that failed for lack of network until it goes out", async () => {
    const { call, send } = fakeCall([new ConnectionError("fetch failed"), new ConnectionError("fetch failed"), "ok"]);
    const d = deps();
    installVoipSendRetry(call, d.value);

    await expect(call.sendVoipEvent("m.call.negotiate", { description: {} })).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([type]) => type === "m.call.negotiate")).toBe(true);
    expect(d.sleeps.length).toBe(2);
  });

  it("retries candidates the same way", async () => {
    const { call, send } = fakeCall([new ConnectionError("fetch failed"), "ok"]);
    installVoipSendRetry(call, deps().value);

    await call.sendVoipEvent("m.call.candidates", { candidates: [] });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("leaves other call events and server errors to the SDK", async () => {
    const hangup = fakeCall([new ConnectionError("fetch failed")]);
    installVoipSendRetry(hangup.call, deps().value);
    await expect(hangup.call.sendVoipEvent("m.call.hangup", {})).rejects.toThrow("fetch failed");
    expect(hangup.send).toHaveBeenCalledTimes(1);

    const forbidden = fakeCall([Object.assign(new Error("M_FORBIDDEN"), { name: "M_FORBIDDEN" })]);
    installVoipSendRetry(forbidden.call, deps().value);
    await expect(forbidden.call.sendVoipEvent("m.call.negotiate", {})).rejects.toThrow("M_FORBIDDEN");
    expect(forbidden.send).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry window, as the SDK would after 30 s of broken ICE", async () => {
    const failures = Array.from({ length: 100 }, () => new ConnectionError("fetch failed"));
    const { call, send } = fakeCall(failures);
    const d = deps();
    installVoipSendRetry(call, d.value);

    await expect(call.sendVoipEvent("m.call.negotiate", {})).rejects.toThrow("fetch failed");

    const waited = d.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(VOIP_SEND_RETRY_WINDOW_MS);
    expect(send.mock.calls.length).toBeGreaterThan(2);
    expect(send.mock.calls.length).toBeLessThan(20);
  });

  it("stops retrying once the call has ended", async () => {
    const { call, send, end } = fakeCall([new ConnectionError("fetch failed"), new ConnectionError("fetch failed"), "ok"]);
    const d = deps({ sleep: vi.fn(async () => { end(); }) });
    installVoipSendRetry(call, d.value);

    await expect(call.sendVoipEvent("m.call.negotiate", {})).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits for the device to come online instead of polling while offline", async () => {
    let online = false;
    const { call, send } = fakeCall([new ConnectionError("fetch failed"), "ok"]);
    const d = deps({
      isOnline: () => online,
      waitForOnline: vi.fn(async () => { online = true; }),
    });
    installVoipSendRetry(call, d.value);

    await call.sendVoipEvent("m.call.negotiate", {});

    expect(d.value.waitForOnline).toHaveBeenCalledOnce();
    expect(d.value.sleep).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("wraps a call only once", async () => {
    const { call, send } = fakeCall([new ConnectionError("fetch failed"), "ok"]);
    installVoipSendRetry(call, deps().value);
    installVoipSendRetry(call, deps().value);

    await call.sendVoipEvent("m.call.negotiate", {});

    expect(send).toHaveBeenCalledTimes(2);
  });

  describe("m.call.answer", () => {
    /** What matrix-js-sdk's fetch throws when WKWebView drops the request. */
    const loadFailed = (): ConnectionError => new ConnectionError("fetch failed: Load failed");

    it("resends an answer that WebKit dropped", async () => {
      const { call, send } = fakeCall([loadFailed(), "ok"]);
      const d = deps();
      installVoipSendRetry(call, d.value);

      await expect(call.sendVoipEvent("m.call.answer", { answer: {} })).resolves.toBeUndefined();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.every(([type]) => type === "m.call.answer")).toBe(true);
      expect(d.sleeps).toEqual([ANSWER_RETRY_POLICY.firstDelayMs]);
    });

    it("gets through on the last attempt", async () => {
      const { call, send } = fakeCall([loadFailed(), loadFailed(), "ok"]);
      installVoipSendRetry(call, deps().value);

      await call.sendVoipEvent("m.call.answer", {});

      expect(send).toHaveBeenCalledTimes(ANSWER_RETRY_POLICY.maxAttempts);
    });

    it("gives up after a few quick attempts and rethrows the SDK's error", async () => {
      const first = loadFailed();
      const { call, send } = fakeCall([loadFailed(), loadFailed(), first, loadFailed(), "ok"]);
      const d = deps();
      installVoipSendRetry(call, d.value);

      await expect(call.sendVoipEvent("m.call.answer", {})).rejects.toBe(first);

      expect(send).toHaveBeenCalledTimes(ANSWER_RETRY_POLICY.maxAttempts);
      const waited = d.sleeps.reduce((a, b) => a + b, 0);
      expect(waited).toBeLessThanOrEqual(ANSWER_RETRY_POLICY.windowMs);
    });

    it("does not resend on a server error", async () => {
      const unknownDevices = Object.assign(new Error("unknown devices"), { name: "UnknownDeviceError" });
      const { call, send } = fakeCall([unknownDevices, "ok"]);
      installVoipSendRetry(call, deps().value);

      await expect(call.sendVoipEvent("m.call.answer", {})).rejects.toBe(unknownDevices);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not resend once the call has ended", async () => {
      const { call, send, end } = fakeCall([loadFailed(), "ok"]);
      installVoipSendRetry(call, deps({ sleep: vi.fn(async () => { end(); }) }).value);

      await expect(call.sendVoipEvent("m.call.answer", {})).rejects.toThrow("Load failed");
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("waits offline no longer than the answer's budget", async () => {
      const { call, send } = fakeCall([loadFailed(), "ok"]);
      const d = deps({ isOnline: () => false });
      installVoipSendRetry(call, d.value);

      await call.sendVoipEvent("m.call.answer", {});

      expect(d.value.waitForOnline).toHaveBeenCalledWith(ANSWER_RETRY_POLICY.windowMs);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
