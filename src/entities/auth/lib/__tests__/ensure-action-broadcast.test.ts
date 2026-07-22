import { describe, it, expect, vi } from "vitest";
import {
  ensureActionBroadcast,
  type BroadcastableAction,
} from "../ensure-action-broadcast";

describe("ensureActionBroadcast", () => {
  it("returns immediately when action already has a transaction", async () => {
    const processingWithIterations = vi.fn();
    const action: BroadcastableAction = {
      transaction: "txid-abc",
      processingWithIterations,
    };
    const result = await ensureActionBroadcast(action);
    expect(result.transaction).toBe("txid-abc");
    expect(processingWithIterations).not.toHaveBeenCalled();
  });

  it("returns immediately when action is already completed", async () => {
    const processingWithIterations = vi.fn();
    const action: BroadcastableAction = {
      completed: true,
      processingWithIterations,
    };
    await ensureActionBroadcast(action);
    expect(processingWithIterations).not.toHaveBeenCalled();
  });

  it("throws when action is already rejected", async () => {
    await expect(
      ensureActionBroadcast({ rejected: "actions_collision" }),
    ).rejects.toThrow("actions_collision");
  });

  it("forces processingWithIterations when queued without a txid", async () => {
    const action: BroadcastableAction = {
      transaction: null,
      processingWithIterations: vi.fn(async () => {
        action.transaction = "txid-sent";
      }),
    };
    const result = await ensureActionBroadcast(action);
    expect(action.processingWithIterations).toHaveBeenCalledWith(true);
    expect(result.transaction).toBe("txid-sent");
  });

  it("throws rejected code when processing sets rejected", async () => {
    const action: BroadcastableAction = {
      processingWithIterations: vi.fn(async () => {
        action.rejected = 18;
        throw new Error("code 18");
      }),
    };
    await expect(ensureActionBroadcast(action)).rejects.toThrow("18");
  });

  it("returns action when processing throws but transaction was set", async () => {
    const action: BroadcastableAction = {
      processingWithIterations: vi.fn(async () => {
        action.transaction = "txid-late";
        throw new Error("actions_checkFail");
      }),
    };
    const result = await ensureActionBroadcast(action);
    expect(result.transaction).toBe("txid-late");
  });

  it("throws when processing finishes with neither tx nor rejection", async () => {
    const action: BroadcastableAction = {
      processingWithIterations: vi.fn(async () => {
        /* still queued — SDK no-op */
      }),
    };
    await expect(ensureActionBroadcast(action)).rejects.toThrow(
      /did not produce a transaction/i,
    );
  });

  it("throws when action is null", async () => {
    await expect(ensureActionBroadcast(null)).rejects.toThrow(/No action/);
  });

  it("throws when queued and processingWithIterations is missing", async () => {
    await expect(ensureActionBroadcast({})).rejects.toThrow(
      /did not produce a transaction/i,
    );
  });
});
