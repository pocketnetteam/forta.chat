import { describe, it, expect } from "vitest";
import { selectUtxos, SATOSHI, DUST_LIMIT } from "./use-wallet";
import type { UTXO } from "./use-wallet";
import { makeUTXO } from "@/test-utils";

describe("selectUtxos", () => {
  it("selects a single UTXO that covers the target", () => {
    const utxos = [makeUTXO({ amountSat: 5 * SATOSHI })];
    const [selected, total] = selectUtxos(utxos, 1 * SATOSHI);
    expect(selected).toHaveLength(1);
    expect(total).toBe(5 * SATOSHI);
  });

  it("prefers fewer, larger UTXOs (descending sort)", () => {
    const utxos = [
      makeUTXO({ amountSat: 1000 }),
      makeUTXO({ amountSat: 50000 }),
      makeUTXO({ amountSat: 3000 }),
    ];
    const [selected] = selectUtxos(utxos, 4000);
    // Should pick the 50000 UTXO first (largest), which already covers 4000
    expect(selected).toHaveLength(1);
    expect(selected[0].amountSat).toBe(50000);
  });

  it("throws 'Insufficient balance' when sum < target", () => {
    const utxos = [
      makeUTXO({ amountSat: 1000 }),
      makeUTXO({ amountSat: 2000 }),
    ];
    expect(() => selectUtxos(utxos, 5000)).toThrow("Insufficient balance");
  });

  it("throws for empty UTXO array", () => {
    expect(() => selectUtxos([], 1000)).toThrow("Insufficient balance");
  });

  it("selects exact match", () => {
    const utxos = [makeUTXO({ amountSat: 5000 })];
    const [selected, total] = selectUtxos(utxos, 5000);
    expect(selected).toHaveLength(1);
    expect(total).toBe(5000);
  });

  it("selects multiple UTXOs when needed", () => {
    const utxos = [
      makeUTXO({ amountSat: 3000 }),
      makeUTXO({ amountSat: 2000 }),
      makeUTXO({ amountSat: 4000 }),
    ];
    // Target 6000: pick 4000 (largest) + 3000 (next) = 7000
    const [selected, total] = selectUtxos(utxos, 6000);
    expect(selected).toHaveLength(2);
    expect(total).toBe(7000);
  });

  it("does not mutate the original array", () => {
    const utxos = [
      makeUTXO({ amountSat: 1000 }),
      makeUTXO({ amountSat: 5000 }),
    ];
    const original = [...utxos];
    selectUtxos(utxos, 1000);
    expect(utxos[0].amountSat).toBe(original[0].amountSat);
    expect(utxos[1].amountSat).toBe(original[1].amountSat);
  });

  it("returns correct total even when overshooting", () => {
    const utxos = [
      makeUTXO({ amountSat: 10000 }),
      makeUTXO({ amountSat: 20000 }),
    ];
    const [, total] = selectUtxos(utxos, 5000);
    // Picks 20000 first (largest), that's enough
    expect(total).toBe(20000);
  });

  it("DUST_LIMIT constant is 700 satoshis", () => {
    expect(DUST_LIMIT).toBe(700);
  });

  it("SATOSHI constant is 100_000_000", () => {
    expect(SATOSHI).toBe(100_000_000);
  });
});
