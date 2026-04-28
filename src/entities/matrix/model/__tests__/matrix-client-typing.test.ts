import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { MatrixClientService } from "../matrix-client";

/**
 * Tests for the typing indicator implementation in matrix-client.ts.
 *
 * Regression guard: typing must use the standard Matrix API
 * (PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}) via
 * `client.sendTyping`, NOT the previous `sendToDevice` workaround
 * with the custom `com.bastyon.typing` event type.
 */

const getSource = () =>
  readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

describe("matrix-client setTyping (source-level regression)", () => {
  it("calls the standard client.sendTyping API", () => {
    const source = getSource();
    expect(source).toMatch(/this\.client\.sendTyping\s*\(\s*roomId\s*,\s*isTyping\s*,/);
  });

  it("does not use the custom sendToDevice typing workaround", () => {
    const source = getSource();
    expect(source).not.toContain("com.bastyon.typing");
    expect(source).not.toContain("TYPING_EVENT_TYPE");
  });

  it("does not maintain client-side typing auto-clear timers", () => {
    const source = getSource();
    expect(source).not.toContain("typingTimers");
  });

  it("does not subscribe to toDeviceEvent for typing", () => {
    const source = getSource();
    // The custom typing listener used `toDeviceEvent` to catch
    // `com.bastyon.typing` events. The standard Matrix SDK delivers typing
    // via `RoomMember.typing`, which must remain. We scope the negative
    // assertion to the exact removed pattern so unrelated future
    // `toDeviceEvent` listeners (e.g. for E2E keys) don't false-trip it.
    expect(source).toContain('"RoomMember.typing"');
    expect(source).not.toMatch(/toDeviceEvent[\s\S]*?com\.bastyon\.typing/);
  });
});

describe("matrix-client setTyping (behavior)", () => {
  let service: MatrixClientService;
  let sendTyping: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new MatrixClientService("test.invalid");
    sendTyping = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { sendTyping };
  });

  it("forwards roomId, isTyping=true and a positive timeout to client.sendTyping", async () => {
    await service.setTyping("!room:test.invalid", true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    const [roomId, isTyping, timeout] = sendTyping.mock.calls[0];
    expect(roomId).toBe("!room:test.invalid");
    expect(isTyping).toBe(true);
    expect(timeout).toBeGreaterThan(0);
  });

  it("uses timeout=0 when stopping typing", async () => {
    await service.setTyping("!room:test.invalid", false);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    const [, isTyping, timeout] = sendTyping.mock.calls[0];
    expect(isTyping).toBe(false);
    expect(timeout).toBe(0);
  });

  it("does not throw when client is not initialized", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = null;
    await expect(service.setTyping("!room:test.invalid", true)).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("swallows errors from sendTyping and logs a warning", async () => {
    sendTyping.mockRejectedValueOnce(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.setTyping("!room:test.invalid", true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
