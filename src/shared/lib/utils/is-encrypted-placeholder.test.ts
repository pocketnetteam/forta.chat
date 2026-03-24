import { describe, it, expect } from "vitest";
import { isEncryptedPlaceholder } from "./is-encrypted-placeholder";

describe("isEncryptedPlaceholder", () => {
  it("detects [encrypted] marker", () => {
    expect(isEncryptedPlaceholder("[encrypted]")).toBe(true);
  });

  it("detects m.bad.encrypted", () => {
    expect(isEncryptedPlaceholder("m.bad.encrypted")).toBe(true);
  });

  it("detects Unable to decrypt", () => {
    expect(isEncryptedPlaceholder("Unable to decrypt")).toBe(true);
  });

  it("detects ** Unable to decrypt ** variants", () => {
    expect(isEncryptedPlaceholder("** Unable to decrypt **")).toBe(true);
    expect(isEncryptedPlaceholder("** Unable to decrypt: key missing **")).toBe(true);
  });

  it("detects Waiting for encryption keys", () => {
    expect(isEncryptedPlaceholder("Waiting for encryption keys")).toBe(true);
  });

  it("returns false for normal message content", () => {
    expect(isEncryptedPlaceholder("Hello world")).toBe(false);
    expect(isEncryptedPlaceholder("This is encrypted in a good way")).toBe(false);
    expect(isEncryptedPlaceholder("[photo]")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isEncryptedPlaceholder(null)).toBe(false);
    expect(isEncryptedPlaceholder(undefined)).toBe(false);
    expect(isEncryptedPlaceholder("")).toBe(false);
  });
});
