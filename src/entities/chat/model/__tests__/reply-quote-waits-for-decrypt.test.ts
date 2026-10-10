import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Audit S1-04. enrichUnresolvedReplies resolved a reply's quote once, from
 * whatever the original held at that moment; when the original was still being
 * decrypted the quote became "[encrypted]" (or empty, for a server-fetched
 * original that failed to decrypt) and nothing ever revisited it. Source-level,
 * like the other chat-store enrichment tests: the pass needs Dexie and Matrix.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
const start = source.indexOf("const enrichUnresolvedReplies = async");
const body = source.slice(start, source.indexOf("\n  };", start));

describe("reply quotes wait for the original to decrypt (audit S1-04)", () => {
  it("treats a quote stored as [encrypted] as unresolved so it heals", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('m.replyTo.content === "[encrypted]"');
  });

  it("does not quote an original that is still pending or failed to decrypt", () => {
    const skip = body.indexOf('original.decryptionStatus === "pending"');
    const quote = body.indexOf("content: stripBastyonLinks(stripMentionAddresses(original.content))");
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(quote);
    expect(body).toContain('original.content === "[encrypted]"');
  });

  it("skips a server-fetched original that cannot be decrypted yet", () => {
    const decrypt = body.indexOf("await roomCrypto.decryptEvent(raw");
    const after = body.slice(decrypt, decrypt + 400);
    expect(after).toMatch(/catch \{[\s\S]*return;/);
  });

  // Merge of S1-04 with the once-per-session refetch guard: marking the event
  // fetched before decrypting it left an undecryptable original out of every
  // later pass, so its quote stayed "[encrypted]" for the whole session.
  it("marks a fetched original as done only after it decrypts", () => {
    const fetch = body.indexOf("await matrixService.client!.fetchRoomEvent(roomId, eventId)");
    const decrypt = body.indexOf("await roomCrypto.decryptEvent(raw", fetch);
    expect(fetch).toBeGreaterThan(-1);
    expect(body.slice(fetch, decrypt)).not.toMatch(/replyFetchAttempted\.add\(eventId\);\s*\n\s*if \(!raw\) return;/);
    const doneAfterDecrypt = body.indexOf("replyFetchAttempted.add(eventId)", decrypt);
    expect(doneAfterDecrypt).toBeGreaterThan(decrypt);
  });
});
