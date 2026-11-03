import { describe, it, expect } from "vitest";
import {
  PENDING_RECEIPT_MAX_AGE_MS,
  parsePendingReceipts,
  pendingReceiptsKey,
  serializePendingReceipts,
} from "../pending-read-receipts";

const NOW = 1_800_000_000_000;

describe("pending read receipts across restarts", () => {
  it("keys the storage by account", () => {
    expect(pendingReceiptsKey("PAddr1")).toBe("chat_pending_read_receipts:PAddr1");
    expect(pendingReceiptsKey("PAddr1")).not.toBe(pendingReceiptsKey("PAddr2"));
  });

  it("round-trips the receipts the server has not acknowledged", () => {
    const map = new Map([
      ["!a:s", { ts: 100, at: NOW - 1000 }],
      ["!b:s", { ts: 200, at: NOW - 2000 }],
    ]);
    expect(parsePendingReceipts(serializePendingReceipts(map), NOW)).toEqual(map);
  });

  it("drops receipts older than the age limit", () => {
    const raw = serializePendingReceipts(new Map([
      ["!old:s", { ts: 100, at: NOW - PENDING_RECEIPT_MAX_AGE_MS - 1 }],
      ["!new:s", { ts: 200, at: NOW - PENDING_RECEIPT_MAX_AGE_MS + 1 }],
    ]));
    expect([...parsePendingReceipts(raw, NOW).keys()]).toEqual(["!new:s"]);
  });

  it("starts empty on a missing, corrupt or malformed entry", () => {
    expect(parsePendingReceipts(null, NOW).size).toBe(0);
    expect(parsePendingReceipts("{not json", NOW).size).toBe(0);
    expect(parsePendingReceipts("[1,2]", NOW).size).toBe(0);
    expect(parsePendingReceipts(JSON.stringify({ "!a:s": { ts: "x", at: NOW }, "!b:s": { ts: 0, at: NOW }, "!c:s": null }), NOW).size).toBe(0);
  });
});
