import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveProfileAddress, clearProfileAddressCache, NAME_LOOKUP_TIMEOUT_MS } from "./resolve-profile-address";

const ADDRESS = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";

describe("resolveProfileAddress", () => {
  beforeEach(() => clearProfileAddressCache());

  it("returns the address of a link by address without a lookup", async () => {
    const lookup = vi.fn();
    expect(await resolveProfileAddress({ address: ADDRESS }, lookup)).toBe(ADDRESS);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks a username up once for repeated links (case-insensitive)", async () => {
    const lookup = vi.fn().mockResolvedValue(ADDRESS);
    const [a, b] = await Promise.all([
      resolveProfileAddress({ name: "Kleine" }, lookup),
      resolveProfileAddress({ name: "kleine" }, lookup),
    ]);
    expect(a).toBe(ADDRESS);
    expect(b).toBe(ADDRESS);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error("rpc")).mockResolvedValueOnce(ADDRESS);
    expect(await resolveProfileAddress({ name: "n" }, lookup)).toBeNull();
    expect(await resolveProfileAddress({ name: "n" }, lookup)).toBe(ADDRESS);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("drops a hung lookup after the timeout so a later card retries", async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn()
        .mockReturnValueOnce(new Promise(() => {})) // never answers
        .mockResolvedValueOnce(ADDRESS);
      const first = resolveProfileAddress({ name: "n" }, lookup);
      await vi.advanceTimersByTimeAsync(NAME_LOOKUP_TIMEOUT_MS + 1);
      expect(await first).toBeNull();

      expect(await resolveProfileAddress({ name: "n" }, lookup)).toBe(ADDRESS);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for an empty target", async () => {
    expect(await resolveProfileAddress({}, vi.fn())).toBeNull();
  });
});
