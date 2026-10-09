import { describe, it, expect } from "vitest";
import { summarizeTransaction, formatPkoinExact, confirmationsOf } from "./transaction-summary";

const SENDER = "PSenderAddressXXXXXXXXXXXXXXXXXXXX";
const RECIPIENT = "PRecipientAddressXXXXXXXXXXXXXXXXX";
const OTHER = "POtherRecipientXXXXXXXXXXXXXXXXXXX";

const out = (address: string | null, value: number) => ({
  value,
  scriptPubKey: address ? { addresses: [address] } : { asm: "OP_RETURN 7368617265" },
});

describe("summarizeTransaction", () => {
  it("reads sender, recipient and amount; change back to the sender is hidden", () => {
    const s = summarizeTransaction({
      txid: "tx1",
      height: 4051390,
      blockHash: "3ece9e7a",
      nTime: 1_700_000_000,
      vin: [{ address: SENDER }, { address: SENDER }],
      vout: [out(null, 0), out(RECIPIENT, 20), out(SENDER, 3.5)],
    });

    expect(s).toEqual({
      txid: "tx1",
      senders: [SENDER],
      recipients: [{ address: RECIPIENT, amount: 20 }],
      total: 20,
      time: 1_700_000_000,
      height: 4051390,
      confirmations: undefined,
    });
  });

  it("lists every paid recipient and sums them", () => {
    const s = summarizeTransaction({
      txid: "tx2",
      vin: [{ address: SENDER }],
      vout: [out(RECIPIENT, 1.5), out(OTHER, 0.25), out(RECIPIENT, 0.5)],
    });

    expect(s?.recipients).toEqual([
      { address: RECIPIENT, amount: 2 },
      { address: OTHER, amount: 0.25 },
    ]);
    expect(s?.total).toBe(2.25);
  });

  it("a transfer to oneself still shows the sender as recipient", () => {
    const s = summarizeTransaction({ txid: "tx3", vin: [{ address: SENDER }], vout: [out(SENDER, 7)] });
    expect(s?.recipients).toEqual([{ address: SENDER, amount: 7 }]);
  });

  it("a mempool transaction has no height and zero confirmations", () => {
    const s = summarizeTransaction({ txid: "tx4", vin: [], vout: [out(RECIPIENT, 1)] });
    expect(s?.height).toBeUndefined();
    expect(confirmationsOf(s!, 4051812)).toBe(0);
  });

  it("a height without a block hash is a mempool tx (psdk fills height with the current block)", () => {
    const s = summarizeTransaction({ txid: "tx5", height: 4051812, vin: [], vout: [out(RECIPIENT, 1)] });
    expect(s?.height).toBeUndefined();
    expect(confirmationsOf(s!, 4051812)).toBe(0);
  });

  it("rejects a response that is not a transaction", () => {
    expect(summarizeTransaction(null)).toBeNull();
    expect(summarizeTransaction({})).toBeNull();
    expect(summarizeTransaction("x")).toBeNull();
  });
});

describe("formatPkoinExact", () => {
  it("prints the exact amount without float noise or trailing zeros", () => {
    expect(formatPkoinExact(20)).toBe("20");
    expect(formatPkoinExact(0.1 + 0.2)).toBe("0.3");
    expect(formatPkoinExact(1.23456789)).toBe("1.23456789");
  });
});

describe("confirmationsOf", () => {
  const mined = summarizeTransaction({ txid: "t", height: 4051390, blockHash: "3ece", vin: [], vout: [out(RECIPIENT, 1)] })!;

  it("counts from the transaction's block to the tip, inclusive (Pocketnet nodes send no confirmations)", () => {
    expect(confirmationsOf(mined, 4051812)).toBe(423);
    expect(confirmationsOf(mined, 4051390)).toBe(1);
  });

  it("a tip behind the transaction block still counts it as confirmed", () => {
    expect(confirmationsOf(mined, 4051000)).toBe(1);
  });

  it("an unknown tip falls back to the node's own count, else 1 for a mined transaction", () => {
    expect(confirmationsOf(mined, 0)).toBe(1);
    expect(confirmationsOf({ ...mined, confirmations: 7 }, 0)).toBe(7);
  });
});
