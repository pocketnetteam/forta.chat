import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixClientService } from "../matrix-client";

/**
 * Regression: while the SDK replays its cached sync, every room goes
 * undefined→join/invite once and emits Room.myMembership — thousands of calls
 * for an account with many invites, each one re-arming refreshRooms(), which
 * could start a full room refresh over a half-loaded list. The handler is
 * gated on chatsReady like the other room handlers.
 */
describe("matrix-client Room.myMembership", () => {
  type Listener = (...args: unknown[]) => void;
  let service: MatrixClientService;
  let listeners: Map<string, Listener>;
  let onMyMembership: ReturnType<typeof vi.fn<(room: unknown, membership: string, prev: string | undefined) => void>>;

  beforeEach(() => {
    service = new MatrixClientService("test.invalid");
    listeners = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = {
      credentials: { userId: "@me:test.invalid" },
      on: (event: string, fn: Listener) => { listeners.set(event, fn); },
    };
    onMyMembership = vi.fn<(room: unknown, membership: string, prev: string | undefined) => void>();
    service.setHandlers({ onMyMembership });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).initEvents();
  });

  const emitMembership = () =>
    listeners.get("Room.myMembership")!({ roomId: "!r:test.invalid" }, "join", undefined);

  it("ignores membership changes before the first PREPARED/SYNCING", () => {
    emitMembership();
    expect(onMyMembership).not.toHaveBeenCalled();
  });

  it("forwards membership changes once chats are ready", () => {
    listeners.get("sync")!("PREPARED");
    emitMembership();
    expect(onMyMembership).toHaveBeenCalledWith({ roomId: "!r:test.invalid" }, "join", undefined);
  });
});
