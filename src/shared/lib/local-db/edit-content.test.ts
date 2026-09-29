import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEditContent } from "./edit-content";

/**
 * «После редактирования сообщение становится зашифрованным» — eleven reports from four users
 * in September 2026, all from groups: the edit's outer content lost the `hash` that names the
 * room's common key, and every reader decrypts the outer content.
 */
describe("buildEditContent", () => {
  it("carries the whole group-encrypted event in the outer content, hash included", () => {
    const encrypted = { msgtype: "m.encrypted", body: "9f3a", block: 3100000, hash: "commonkey-hash" };
    expect(buildEditContent("$orig", "new text", encrypted)).toEqual({
      msgtype: "m.encrypted",
      body: "9f3a",
      block: 3100000,
      hash: "commonkey-hash",
      "m.new_content": encrypted,
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
    });
  });

  it("keeps the one-to-one shape: body, block and version, no hash", () => {
    const encrypted = { msgtype: "m.encrypted", body: "eyJ…", block: 3100000, version: 2 };
    const content = buildEditContent("$orig", "new text", encrypted);
    expect(content).toMatchObject({ msgtype: "m.encrypted", body: "eyJ…", block: 3100000, version: 2 });
    expect(content).not.toHaveProperty("hash");
    expect(JSON.stringify(content)).not.toContain("new text");
  });

  it("builds the plain Matrix edit for a room without encryption", () => {
    expect(buildEditContent("$orig", "new text", null)).toEqual({
      msgtype: "m.text",
      body: "* new text",
      "m.new_content": { msgtype: "m.text", body: "new text" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
    });
  });

  it("is the only place either edit sender gets its content from", () => {
    // The fallback sender in use-messages.ts used to put the cleartext into m.new_content of an
    // encrypted edit; the SyncEngine sender dropped `hash`.
    const root = resolve(__dirname, "../../..");
    for (const file of ["shared/lib/local-db/sync-engine.ts", "features/messaging/model/use-messages.ts"]) {
      const source = readFileSync(resolve(root, file), "utf-8");
      expect(source, file).toContain("buildEditContent(");
      expect(source, file).not.toMatch(/rel_type:\s*"m\.replace"/);
    }
  });
});
