import { describe, it, expect } from "vitest";
import { buildEncryptedEditContent } from "./encrypted-edit";

describe("buildEncryptedEditContent", () => {
  it("keeps the group `hash` at the top level so readers route to decryptEventGroup", () => {
    const group = { msgtype: "m.encrypted", body: "a1b2c3", block: 10, hash: "h123" };
    const content = buildEncryptedEditContent(group, "$orig");

    expect(content.hash).toBe("h123");
    expect(content.body).toBe("a1b2c3");
    expect(content.block).toBe(10);
    expect(content.msgtype).toBe("m.encrypted");
  });

  it("keeps 1:1 block/version at the top level", () => {
    const direct = { msgtype: "m.encrypted", body: "eyJ9", block: 3500000, version: 2 };
    const content = buildEncryptedEditContent(direct, "$orig");

    expect(content.version).toBe(2);
    expect(content.block).toBe(3500000);
    expect(content).not.toHaveProperty("hash");
  });

  it("sets the m.replace relation to the edited event", () => {
    const content = buildEncryptedEditContent({ msgtype: "m.encrypted", body: "x" }, "$orig");
    expect(content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" });
  });

  it("m.new_content carries the ciphertext, never plaintext", () => {
    const group = { msgtype: "m.encrypted", body: "a1b2c3", block: 10, hash: "h123" };
    const content = buildEncryptedEditContent(group, "$orig");

    expect(content["m.new_content"]).toEqual(group);
    // A copy, so later mutation of the outer content cannot leak into it.
    expect(content["m.new_content"]).not.toBe(group);
  });
});
