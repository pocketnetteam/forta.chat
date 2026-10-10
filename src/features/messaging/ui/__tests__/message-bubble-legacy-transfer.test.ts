import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bubble = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

/**
 * A legacy `{"_transfer":true,…}` message is any sender's text: amount and
 * parties in it are unverified, and its txId may be missing or garbage.
 * Source-level, matching the MessageBubble test style.
 */
describe("MessageBubble — legacy JSON transfer", () => {
  const block = bubble.match(/<!-- Legacy transfer message[\s\S]*?<\/p>/)?.[0] ?? "";

  it("renders the chain-verified transaction card, not the JSON's amount/parties", () => {
    expect(block).toMatch(/<TransactionLinkCard/);
    expect(block).not.toMatch(/transferInfo\.amount|transferInfo\.from|transferInfo\.to\b/);
    expect(bubble).not.toMatch(/TransferCard/);
  });

  it("shows the card only for a valid txid, so a crafted JSON can't break the bubble", () => {
    expect(block).toMatch(/v-if="isTxid\(message\.transferInfo\.txId\)"/);
  });

  it("keeps the sender's note as plain text", () => {
    expect(block).toMatch(/data-testid="transfer-note"[\s\S]*?\{\{ message\.transferInfo\.message \}\}/);
  });
});
