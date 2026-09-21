import { describe, it, expect, vi } from "vitest";
import { parseEditBody } from "./parse-edit";

/** Synthetic decrypt helper — returns the supplied body for clear events and
 *  a deterministic string for encrypted ones. Individual tests override it. */
function makeDecrypt(result: string | Error) {
  return vi.fn(async (_raw: Record<string, unknown>) => {
    if (result instanceof Error) throw result;
    return { body: result, msgtype: "m.text" };
  });
}

describe("parseEditBody", () => {
  it("returns decrypted body when top-level event is encrypted and decryption succeeds", async () => {
    const decrypt = makeDecrypt("Hello, world!");
    const body = await parseEditBody({
      raw: { type: "m.room.message", content: {} },
      content: { msgtype: "m.encrypted", body: "<CIPHERTEXT_BLOB>" },
      newContent: undefined,
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    expect(body).toBe("Hello, world!");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("returns decrypted body when m.new_content is encrypted", async () => {
    const decrypt = makeDecrypt("Edited text");
    const body = await parseEditBody({
      raw: { type: "m.room.message" },
      content: { body: "* fallback" },
      newContent: { msgtype: "m.encrypted", body: "<CIPHERTEXT>" },
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    expect(body).toBe("Edited text");
  });

  it("returns placeholder (NOT ciphertext) when decryption fails — bug #193/#222", async () => {
    const decrypt = makeDecrypt(new Error("MAC mismatch"));
    const body = await parseEditBody({
      raw: {},
      content: { msgtype: "m.encrypted", body: "<UNREADABLE_CIPHER>" },
      newContent: { msgtype: "m.encrypted", body: "<UNREADABLE_CIPHER>" },
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    // The critical assertion: we must NOT leak raw ciphertext to the UI.
    expect(body).toBe("[зашифровано]");
    expect(body).not.toContain("CIPHER");
  });

  it("returns newContent.body for clear-room edits (no decrypt needed)", async () => {
    const decrypt = makeDecrypt("should-not-be-called");
    const body = await parseEditBody({
      raw: {},
      content: { msgtype: "m.text", body: "* edited" },
      newContent: { msgtype: "m.text", body: "edited" },
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    expect(body).toBe("edited");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("falls back to content.body when newContent is missing in clear rooms", async () => {
    const decrypt = makeDecrypt("ignored");
    const body = await parseEditBody({
      raw: {},
      content: { msgtype: "m.text", body: "direct body" },
      newContent: undefined,
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    expect(body).toBe("direct body");
  });

  describe("group edits sent without outer `hash` (older Forta builds)", () => {
    it("lifts `hash` from m.new_content so the edit routes to group decryption", async () => {
      const decrypt = makeDecrypt("Edited in group");
      const raw = {
        event_id: "$edit",
        sender: "@abc:server",
        content: { msgtype: "m.encrypted", body: "a1b2c3", block: 10 },
      };
      const newContent = { msgtype: "m.encrypted", body: "a1b2c3", block: 10, hash: "h123" };

      const body = await parseEditBody({
        raw,
        content: raw.content,
        newContent,
        decryptEvent: decrypt,
        encryptedPlaceholder: "[зашифровано]",
      });

      expect(body).toBe("Edited in group");
      const passed = decrypt.mock.calls[0][0];
      expect((passed.content as Record<string, unknown>).hash).toBe("h123");
      expect(passed.event_id).toBe("$edit");
      expect(passed.sender).toBe("@abc:server");
      // The caller's event object is not mutated.
      expect(raw.content).not.toHaveProperty("hash");
    });

    it("passes the event through unchanged when the outer content already has `hash`", async () => {
      const decrypt = makeDecrypt("ok");
      const raw = { content: { msgtype: "m.encrypted", body: "a1", block: 10, hash: "outer" } };

      await parseEditBody({
        raw,
        content: raw.content,
        newContent: { msgtype: "m.encrypted", body: "a1", hash: "inner" },
        decryptEvent: decrypt,
        encryptedPlaceholder: "[зашифровано]",
      });

      expect(decrypt.mock.calls[0][0]).toBe(raw);
    });

    it("does not touch 1:1 edits (no hash anywhere)", async () => {
      const decrypt = makeDecrypt("ok");
      const raw = { content: { msgtype: "m.encrypted", body: "eyJ9", block: 5, version: 2 } };

      await parseEditBody({
        raw,
        content: raw.content,
        newContent: { msgtype: "m.encrypted", body: "eyJ9", block: 5, version: 2 },
        decryptEvent: decrypt,
        encryptedPlaceholder: "[зашифровано]",
      });

      expect(decrypt.mock.calls[0][0]).toBe(raw);
    });
  });

  it("returns empty string when both bodies are missing in clear rooms", async () => {
    const decrypt = makeDecrypt("ignored");
    const body = await parseEditBody({
      raw: {},
      content: {},
      newContent: undefined,
      decryptEvent: decrypt,
      encryptedPlaceholder: "[зашифровано]",
    });
    expect(body).toBe("");
  });
});
