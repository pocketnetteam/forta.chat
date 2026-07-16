import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "../extract-error";

const FALLBACK = "Operation failed";

describe("extractErrorMessage", () => {
  it("returns the message of an Error instance", () => {
    // Arrange
    const err = new Error("Insufficient balance");

    // Act
    const result = extractErrorMessage(err, FALLBACK);

    // Assert
    expect(result).toBe("Insufficient balance");
    expect(result).not.toContain("[object Object]");
  });

  it("returns a thrown string as-is", () => {
    expect(extractErrorMessage("Network unavailable", FALLBACK)).toBe("Network unavailable");
  });

  it("extracts message from a plain RPC object { code, message }", () => {
    // Arrange — Pocketnet RPC error shape that previously rendered "[object Object]"
    const rpcErr = { code: -6, message: "Fee estimation failed" };

    // Act
    const result = extractErrorMessage(rpcErr, FALLBACK);

    // Assert
    expect(result).toBe("Fee estimation failed");
    expect(result).not.toContain("[object Object]");
  });

  it("extracts message from a nested { error: { message } } shape", () => {
    const nested = { error: { code: -1, message: "Recipient invalid" } };
    expect(extractErrorMessage(nested, FALLBACK)).toBe("Recipient invalid");
  });

  it("extracts a string nested under { error }", () => {
    expect(extractErrorMessage({ error: "Server down" }, FALLBACK)).toBe("Server down");
  });

  it("falls back for opaque objects without a message", () => {
    // Arrange — the exact bug: an object with no readable message
    const opaque = { code: "X", details: "bad" };

    // Act
    const result = extractErrorMessage(opaque, FALLBACK);

    // Assert
    expect(result).toBe(FALLBACK);
    expect(result).not.toContain("[object Object]");
  });

  it("falls back for null / undefined", () => {
    expect(extractErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(extractErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for an Error with an empty message", () => {
    expect(extractErrorMessage(new Error(""), FALLBACK)).toBe(FALLBACK);
  });
});
