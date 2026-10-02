import { describe, it, expect, afterEach, vi } from "vitest";
import Dexie from "dexie";
import { SyncEngine } from "../sync-engine";
import { waitTicks } from "./sync-engine-test-helpers";

/**
 * The queue tick runs from a bare setTimeout. When the DB closed while a
 * claim was in flight (logout, or a test tearing its DB down), the claim's
 * rejection escaped as an unhandled rejection — seen as a red `npm run test`
 * with every test passing, once files started running in parallel.
 */

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({}),
}));

function makeEngine(transaction: () => Promise<never>): SyncEngine {
  const db = { transaction: vi.fn(transaction) };
  return new SyncEngine(db as never, {} as never, {} as never, async () => undefined);
}

async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    // Unhandled rejections are reported after the microtask queue drains.
    await waitTicks(5);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

describe("SyncEngine queue tick — DB failing mid-claim", () => {
  let engine: SyncEngine | undefined;

  afterEach(() => {
    engine?.dispose();
    engine = undefined;
    vi.restoreAllMocks();
  });

  it("swallows a DatabaseClosedError without an unhandled rejection or a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine = makeEngine(() => Promise.reject(new Dexie.DatabaseClosedError()));

    const unhandled = await collectUnhandled(async () => {
      await engine!.processQueue();
      await waitTicks(3);
    });

    expect(unhandled).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs any other failure and keeps the engine able to tick again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi.fn(() => Promise.reject(new Error("quota exceeded")));
    engine = makeEngine(transaction);

    const unhandled = await collectUnhandled(async () => {
      await engine!.processQueue();
      await waitTicks(3);
      // `processing` must be released, or this second kick is swallowed.
      await engine!.processQueue();
      await waitTicks(3);
    });

    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[SyncEngine] queue tick failed:", expect.any(Error));
    expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
