import { describe, it, expect, vi } from "vitest";
import {
  selectUtxos,
  isTimeoutError,
  fetchUnspents,
  MAX_INPUTS,
  ERR_TOO_MANY_INPUTS,
  SATOSHI,
  DUST_LIMIT,
} from "../utxo";
import { makeUTXO } from "@/test-utils";

describe("selectUtxos input cap (WEE-72)", () => {
  it("MAX_INPUTS is 300", () => {
    expect(MAX_INPUTS).toBe(300);
  });

  it("throws TOO_MANY_INPUTS (not Insufficient balance) when funds are fragmented", () => {
    // 400 UTXOs of 1000 sat = 400_000 available, but only 300 may be used.
    // 350_000 would need 350 inputs → over the cap → balance is fine, inputs aren't.
    const utxos = Array.from({ length: 400 }, () => makeUTXO({ amountSat: 1000 }));
    expect(() => selectUtxos(utxos, 350_000)).toThrow(ERR_TOO_MANY_INPUTS);
  });

  it("still throws Insufficient balance when the total genuinely falls short", () => {
    // Few UTXOs, under the cap, total below target → truly insufficient.
    const utxos = [makeUTXO({ amountSat: 1000 }), makeUTXO({ amountSat: 2000 })];
    expect(() => selectUtxos(utxos, 10_000)).toThrow("Insufficient balance");
  });

  it("selects exactly MAX_INPUTS when the target needs them", () => {
    const utxos = Array.from({ length: 400 }, () => makeUTXO({ amountSat: 1000 }));
    const [selected, total] = selectUtxos(utxos, 300_000);
    expect(selected.length).toBeLessThanOrEqual(MAX_INPUTS);
    expect(total).toBeGreaterThanOrEqual(300_000);
  });

  it("constants are re-exported with expected values", () => {
    expect(SATOSHI).toBe(100_000_000);
    expect(DUST_LIMIT).toBe(700);
  });
});

describe("isTimeoutError", () => {
  it("detects the 408 GetUnspents shape from the bug report", () => {
    expect(isTimeoutError({ code: 408, message: "GetUnspents: sql request timeout" })).toBe(true);
  });

  it("detects retryable codes 429 and -28", () => {
    expect(isTimeoutError({ code: 429 })).toBe(true);
    expect(isTimeoutError({ code: -28 })).toBe(true);
  });

  it("detects timeout text inside the message", () => {
    expect(isTimeoutError({ message: "Connection Rejected: sql request timeout" })).toBe(true);
  });

  it("detects nested { error: { code } } shape", () => {
    expect(isTimeoutError({ error: { code: 408, message: "timeout" } })).toBe(true);
  });

  it("detects bare string timeouts", () => {
    expect(isTimeoutError("408")).toBe(true);
    expect(isTimeoutError("sql request timeout")).toBe(true);
  });

  it("returns false for non-timeout errors", () => {
    expect(isTimeoutError({ code: -6, message: "Insufficient funds" })).toBe(false);
    expect(isTimeoutError(new Error("Insufficient balance"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError("nope")).toBe(false);
  });
});

describe("fetchUnspents (retry on timeout)", () => {
  it("requests all UTXOs with the expected txunspent params", async () => {
    const rpc = vi.fn().mockResolvedValue([]);
    await fetchUnspents({ rpc }, "PAddr", { baseDelayMs: 0 });
    expect(rpc).toHaveBeenCalledWith("txunspent", [["PAddr"], 1, 9999999]);
  });

  it("retries a timeout and resolves on the next attempt", async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce({ code: 408, message: "sql request timeout" })
      .mockResolvedValueOnce([makeUTXO()]);
    const result = await fetchUnspents({ rpc }, "PAddr", { baseDelayMs: 0 });
    expect(result).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const err = { code: 408, message: "sql request timeout" };
    const rpc = vi.fn().mockRejectedValue(err);
    await expect(
      fetchUnspents({ rpc }, "PAddr", { retries: 2, baseDelayMs: 0 }),
    ).rejects.toBe(err);
    expect(rpc).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry non-timeout errors", async () => {
    const err = { code: -6, message: "bad request" };
    const rpc = vi.fn().mockRejectedValue(err);
    await expect(fetchUnspents({ rpc }, "PAddr", { baseDelayMs: 0 })).rejects.toBe(err);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
