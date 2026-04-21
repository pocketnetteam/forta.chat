import { describe, it, expect, vi } from "vitest";
import { parseEditBody } from "./parse-edit";

/** Synthetic decrypt helper — returns the supplied body for clear events and
 *  a deterministic string for encrypted ones. Individual tests override it. */
function makeDecrypt(result: string | Error) {
  return vi.fn(async () => {
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
