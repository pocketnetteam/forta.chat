import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { MatrixClientService } from "../matrix-client";

/**
 * Regression: the SDK advances the /sync token BEFORE processing a batch and
 * then emits Room.timeline / membership / … synchronously. A listener of ours
 * that throws propagates out of emit() into processSyncResponse, which the SDK
 * catches as SyncUnexpectedError — the rest of that batch is dropped for good.
 * A persistent throw = "messages never arrive in any chat, restart doesn't
 * help". Our listeners must contain their own failures, and everything that
 * does go wrong in the /sync pipeline must land in the bug-report snapshot.
 */

type FakeClient = EventEmitter & {
  credentials: { userId: string };
  getSyncToken: () => string | null;
  getRooms: () => unknown[];
};

function makeService() {
  const service = new MatrixClientService("matrix.test");
  const client = Object.assign(new EventEmitter(), {
    credentials: { userId: "@me:matrix.test" },
    getSyncToken: () => "s123_456",
    getRooms: () => [{}, {}],
  }) as FakeClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = service as any;
  svc.client = client;
  svc.initEvents();
  return { service, client };
}

function timelineEvent(roomId = "!r:matrix.test") {
  return { event: { type: "m.room.message", room_id: roomId, content: { body: "hi" } } };
}

describe("MatrixClientService — SDK listeners never throw into the SDK", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a throwing onTimeline does not escape emit() and later events still reach the handler", () => {
    const { service, client } = makeService();
    const onTimeline = vi.fn()
      .mockImplementationOnce(() => { throw new TypeError("boom"); })
      .mockImplementation(() => {});
    service.setHandlers({ onTimeline });
    client.emit("sync", "PREPARED", null, undefined); // chatsReady = true

    expect(() => client.emit("Room.timeline", timelineEvent(), {}, false)).not.toThrow();
    client.emit("Room.timeline", timelineEvent(), {}, false);

    expect(onTimeline).toHaveBeenCalledTimes(2);
    const diag = service.getSyncDiagnostics();
    expect(diag.listenerErrorCount).toBe(1);
    expect(diag.lastListenerError).toBe("Room.timeline: TypeError boom");
  });

  it("a throwing onSync does not escape the SDK's sync emit", () => {
    const { service, client } = makeService();
    service.setHandlers({ onSync: () => { throw new Error("store blew up"); } });

    expect(() => client.emit("sync", "SYNCING", null, undefined)).not.toThrow();
    expect(service.getSyncDiagnostics().lastListenerError).toBe("sync: Error store blew up");
  });

  it.each([
    ["RoomMember.membership", "onMembership", [{}, { roomId: "!r" }]],
    ["Room.receipt", "onReceipt", [{}, {}]],
    ["Room.redaction", "onRedaction", [{}, {}]],
    ["Room.myMembership", "onMyMembership", [{}, "leave", "join"]],
    ["Room", "onRoom", [{}]],
    ["Room.accountData", "onRoomAccountData", [{}, {}]],
    ["accountData", "onAccountData", [{}]],
    ["RoomMember.typing", "onTyping", [{}, {}]],
    ["Call.incoming", "onIncomingCall", [{}]],
  ] as const)("%s listener is guarded", (eventName, handlerName, args) => {
    const { service, client } = makeService();
    service.setHandlers({ [handlerName]: () => { throw new Error("x"); } });
    client.emit("sync", "PREPARED", null, undefined);

    expect(() => client.emit(eventName, ...args)).not.toThrow();
    expect(service.getSyncDiagnostics().listenerErrorCount).toBe(1);
  });

  it("pagination (toStartOfTimeline) events are not counted as live traffic", () => {
    const { service, client } = makeService();
    client.emit("sync", "PREPARED", null, undefined);

    client.emit("Room.timeline", timelineEvent(), {}, true);
    expect(service.getSyncDiagnostics().timelineEventCount).toBe(0);

    client.emit("Room.timeline", timelineEvent(), {}, false);
    expect(service.getSyncDiagnostics().timelineEventCount).toBe(1);
  });

  it("live events before PREPARED are counted (SDK delivered them) but not forwarded", () => {
    const { service, client } = makeService();
    const onTimeline = vi.fn();
    service.setHandlers({ onTimeline });

    client.emit("Room.timeline", timelineEvent(), {}, false);

    expect(onTimeline).not.toHaveBeenCalled();
    expect(service.getSyncDiagnostics().timelineEventCount).toBe(1);
  });
});

describe("MatrixClientService — /sync diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records sync states and the error the SDK attaches to ERROR", () => {
    const { service, client } = makeService();
    client.emit("sync", "PREPARED", null, undefined);
    client.emit("sync", "ERROR", "PREPARED", {
      error: { errcode: "M_UNKNOWN_TOKEN", httpStatus: 401, message: "Invalid access token" },
    });

    const diag = service.getSyncDiagnostics();
    expect(diag.lastState).toBe("ERROR");
    expect(diag.errorsSinceHealthy).toBe(1);
    expect(diag.lastError).toBe("M_UNKNOWN_TOKEN HTTP 401 Invalid access token");
    expect(diag.healthyCount).toBe(1);
  });

  it("records batches the SDK dropped (sync.unexpectedError)", () => {
    const { service, client } = makeService();
    client.emit("sync.unexpectedError", new TypeError("Cannot read properties of undefined"));

    const diag = service.getSyncDiagnostics();
    expect(diag.unexpectedErrorCount).toBe(1);
    expect(diag.lastUnexpectedError).toBe("TypeError Cannot read properties of undefined");
  });

  it("snapshot includes live client facts: host, sync token, rooms, chatsReady", () => {
    const { service, client } = makeService();
    client.emit("sync", "PREPARED", null, undefined);

    expect(service.getSyncDiagnostics()).toMatchObject({
      host: "matrix.test",
      hasSyncToken: true,
      roomCount: 2,
      chatsReady: true,
    });
  });

  it("getSyncDiagnostics never throws on a broken or missing client", () => {
    const { service, client } = makeService();
    client.getSyncToken = () => { throw new Error("store closed"); };
    client.getRooms = () => { throw new Error("store closed"); };
    expect(service.getSyncDiagnostics()).toMatchObject({ hasSyncToken: false, roomCount: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = null;
    expect(service.getSyncDiagnostics()).toMatchObject({ hasSyncToken: false, roomCount: 0 });
  });
});
