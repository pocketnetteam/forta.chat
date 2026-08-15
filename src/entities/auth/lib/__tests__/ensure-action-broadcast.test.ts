import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  ensureActionBroadcast,
  type BroadcastableAction,
} from "../ensure-action-broadcast";

describe("ensureActionBroadcast", () => {
  it("returns immediately when action already has a transaction", async () => {
    const processingWithIteractions = vi.fn();
    const action: BroadcastableAction = {
      transaction: "txid-abc",
      processingWithIteractions,
    };
    const result = await ensureActionBroadcast(action);
    expect(result.transaction).toBe("txid-abc");
    expect(processingWithIteractions).not.toHaveBeenCalled();
  });

  it("returns immediately when action is already completed", async () => {
    const processingWithIteractions = vi.fn();
    const action: BroadcastableAction = {
      completed: true,
      processingWithIteractions,
    };
    await ensureActionBroadcast(action);
    expect(processingWithIteractions).not.toHaveBeenCalled();
  });

  it("throws when action is already rejected", async () => {
    await expect(
      ensureActionBroadcast({ rejected: "actions_collision" }),
    ).rejects.toThrow("actions_collision");
  });

  it("forces processingWithIteractions when queued without a txid", async () => {
    const action: BroadcastableAction = {
      transaction: null,
      processingWithIteractions: vi.fn(async () => {
        action.transaction = "txid-sent";
      }),
    };
    const result = await ensureActionBroadcast(action);
    expect(action.processingWithIteractions).toHaveBeenCalledWith(true);
    expect(result.transaction).toBe("txid-sent");
  });

  it("throws rejected code when processing sets rejected", async () => {
    const action: BroadcastableAction = {
      processingWithIteractions: vi.fn(async () => {
        action.rejected = 18;
        throw new Error("code 18");
      }),
    };
    await expect(ensureActionBroadcast(action)).rejects.toThrow("18");
  });

  it("returns action when processing throws but transaction was set", async () => {
    const action: BroadcastableAction = {
      processingWithIteractions: vi.fn(async () => {
        action.transaction = "txid-late";
        throw new Error("actions_checkFail");
      }),
    };
    const result = await ensureActionBroadcast(action);
    expect(result.transaction).toBe("txid-late");
  });

  it("throws when processing finishes with neither tx nor rejection", async () => {
    const action: BroadcastableAction = {
      processingWithIteractions: vi.fn(async () => {
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

  it("throws when queued and processingWithIteractions is missing", async () => {
    await expect(ensureActionBroadcast({})).rejects.toThrow(
      /did not produce a transaction/i,
    );
  });
});

describe("ensureActionBroadcast matches the real vendor method name", () => {
  // Regression guard: the vendor Actions SDK (public/js/lib/client/actions.js)
  // names its force-send method `processingWithIteractions` — not the more
  // natural `processingWithIterations`. ensure-action-broadcast.ts previously
  // used the "corrected" spelling, so `typeof action.processingWithIterations
  // === "function"` was always false at runtime: the force-send call silently
  // no-op'd, every broadcast fell straight through to "did not produce a
  // transaction", and every registration poll retry queued a brand new
  // UserInfo action instead of ever driving the first one to completion —
  // which is what piled up actions for the vendor's own collision guard to
  // reject ("actions_collision"). Guard against a "helpful" future rename
  // back to the correct spelling silently reintroducing the same bug.
  const vendorSource = readFileSync(
    resolve(__dirname, "../../../../../public/js/lib/client/actions.js"),
    "utf-8",
  );
  const ourSource = readFileSync(
    resolve(__dirname, "../ensure-action-broadcast.ts"),
    "utf-8",
  );

  it("vendor Actions SDK exposes processingWithIteractions (not processingWithIterations)", () => {
    expect(vendorSource).toContain("processingWithIteractions");
    expect(vendorSource).not.toContain("processingWithIterations");
  });

  it("ensure-action-broadcast.ts calls the same spelling the vendor SDK actually exposes", () => {
    // The interface field and both live call sites must use the vendor
    // spelling — a doc comment nearby is allowed to still mention the wrong
    // one for context, so this checks the functional call sites specifically
    // rather than banning the string from the whole file.
    expect(ourSource).toContain("processingWithIteractions?:");
    expect(ourSource).toContain('typeof action.processingWithIteractions === "function"');
    expect(ourSource).toContain("await action.processingWithIteractions(true)");
  });
});
