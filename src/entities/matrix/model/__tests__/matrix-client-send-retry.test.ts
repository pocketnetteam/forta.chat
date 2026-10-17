import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixClientService } from "../matrix-client";

/**
 * The outbound queue retries a send with the same txnId (the message's
 * clientId) so the server dedupes it. matrix-js-sdk keeps a failed send's
 * local echo under that txnId as NOT_SENT and throws "addPendingEvent called
 * on an event with known txnId" for a second sendEvent with it. Every retry
 * failed without reaching the server, and one network error during the PUT
 * failed the message for good (web bench, 2026-10-10: the PUT aborted once,
 * four retries, no request, "failed" after 38 s).
 */
const ROOM = "!room:test.invalid";
const TXN = "client-id-1";

describe("matrix-client sends retried with the same txnId", () => {
  let service: MatrixClientService;
  let sendEvent: ReturnType<typeof vi.fn>;
  let resendEvent: ReturnType<typeof vi.fn>;
  let echo: { status: string; getId: () => string } | undefined;
  const room = { getEventForTxnId: vi.fn(() => echo) };

  beforeEach(() => {
    echo = undefined;
    service = new MatrixClientService("test.invalid");
    sendEvent = vi.fn().mockResolvedValue({ event_id: "$fresh" });
    resendEvent = vi.fn().mockResolvedValue({ event_id: "$resent" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { sendEvent, resendEvent, getRoom: vi.fn(() => room) };
  });

  it("sends a first attempt as usual", async () => {
    await expect(service.sendEncryptedText(ROOM, { body: "x" }, TXN)).resolves.toBe("$fresh");
    expect(sendEvent).toHaveBeenCalledWith(ROOM, "m.room.message", { body: "x" }, TXN);
  });

  it("resends the failed local echo instead of a second sendEvent with its txnId", async () => {
    echo = { status: "not_sent", getId: () => `~${ROOM}:${TXN}` };
    await expect(service.sendEncryptedText(ROOM, { body: "x" }, TXN)).resolves.toBe("$resent");
    expect(resendEvent).toHaveBeenCalledWith(echo, room);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("answers with the event id when the earlier attempt went through after all", async () => {
    echo = { status: "sent", getId: () => "$already" };
    await expect(service.sendEncryptedText(ROOM, { body: "x" }, TXN)).resolves.toBe("$already");
    expect(sendEvent).not.toHaveBeenCalled();
    expect(resendEvent).not.toHaveBeenCalled();
  });

  it("covers sendText with a txnId too", async () => {
    echo = { status: "not_sent", getId: () => `~${ROOM}:${TXN}` };
    await expect(service.sendText(ROOM, "hi", TXN)).resolves.toBe("$resent");
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
