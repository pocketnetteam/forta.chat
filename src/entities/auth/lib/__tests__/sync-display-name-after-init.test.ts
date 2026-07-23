import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  syncDisplayNameAfterInit,
  type MatrixDisplayNameSync,
} from "../sync-display-name-after-init";

describe("syncDisplayNameAfterInit", () => {
  let setDisplayName: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  const userId = "PXtestAddress123";

  beforeEach(() => {
    setDisplayName = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const matrix = (): MatrixDisplayNameSync => ({ setDisplayName });

  it("skips setDisplayName when name is missing", async () => {
    await syncDisplayNameAfterInit(matrix(), { userId, name: undefined });
    await syncDisplayNameAfterInit(matrix(), { userId, name: null });
    await syncDisplayNameAfterInit(matrix(), { userId, name: "" });

    expect(setDisplayName).not.toHaveBeenCalled();
    expect(localStorage.getItem(`dsname_${userId}`)).toBeNull();
  });

  it("writes cache and calls setDisplayName when name is new", async () => {
    await syncDisplayNameAfterInit(matrix(), { userId, name: "Alice" });

    expect(setDisplayName).toHaveBeenCalledTimes(1);
    expect(setDisplayName).toHaveBeenCalledWith("Alice");
    expect(localStorage.getItem(`dsname_${userId}`)).toBe("Alice");
  });

  it("skips setDisplayName when name matches cache", async () => {
    localStorage.setItem(`dsname_${userId}`, "Alice");

    await syncDisplayNameAfterInit(matrix(), { userId, name: "Alice" });

    expect(setDisplayName).not.toHaveBeenCalled();
    expect(localStorage.getItem(`dsname_${userId}`)).toBe("Alice");
  });

  it("updates cache and calls setDisplayName when name changed", async () => {
    localStorage.setItem(`dsname_${userId}`, "Alice");

    await syncDisplayNameAfterInit(matrix(), { userId, name: "Bob" });

    expect(setDisplayName).toHaveBeenCalledTimes(1);
    expect(setDisplayName).toHaveBeenCalledWith("Bob");
    expect(localStorage.getItem(`dsname_${userId}`)).toBe("Bob");
  });

  it("swallows setDisplayName errors without rejecting", async () => {
    setDisplayName.mockRejectedValue(new Error("network fail"));

    await expect(
      syncDisplayNameAfterInit(matrix(), { userId, name: "Alice" }),
    ).resolves.toBeUndefined();

    expect(setDisplayName).toHaveBeenCalledWith("Alice");
    // Cache is written before the call (1:1 with reference)
    expect(localStorage.getItem(`dsname_${userId}`)).toBe("Alice");
  });
});
