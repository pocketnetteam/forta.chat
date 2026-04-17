import { describe, it, expect, vi } from "vitest";
import { ProxyRotator } from "../proxy-rotator";

describe("ProxyRotator", () => {
  it("returns result from first proxy on success", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    const fn = vi.fn(async (p: string) => `ok:${p}`);

    const result = await rotator.call(fn);

    expect(result).toBe("ok:a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("rotates to next proxy on failure", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    const fn = vi.fn(async (p: string) => {
      if (p === "a") throw new Error("a down");
      return `ok:${p}`;
    });

    const result = await rotator.call(fn);

    expect(result).toBe("ok:b");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "b");
  });

  it("tries every proxy before giving up", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    const fn = vi.fn(async () => {
      throw new Error("all down");
    });

    await expect(rotator.call(fn)).rejects.toThrow(/all registration proxies failed/i);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("persists rotation for subsequent calls (sticky on last-good)", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    let aDown = true;
    const fn = vi.fn(async (p: string) => {
      if (p === "a" && aDown) throw new Error("a down");
      return `ok:${p}`;
    });

    const r1 = await rotator.call(fn);
    expect(r1).toBe("ok:b");

    // Second call should START on b (last good), not a
    const r2 = await rotator.call(fn);
    expect(r2).toBe("ok:b");
    // Second call fn start: should have been exactly 1 call (fn total: 2 first call + 1 second)
    expect(fn).toHaveBeenCalledTimes(3);
    // Last call was with "b", not "a"
    expect(fn.mock.calls[fn.mock.calls.length - 1][0]).toBe("b");
  });

  it("wraps around the proxy list", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    const fn = vi.fn(async (p: string) => {
      if (p !== "c") throw new Error("down");
      return "ok:c";
    });

    const result = await rotator.call(fn);
    expect(result).toBe("ok:c");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when proxy list is empty", async () => {
    const rotator = new ProxyRotator([]);
    await expect(rotator.call(async () => "ok")).rejects.toThrow();
  });

  it("current() returns the current proxy index head", () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    expect(rotator.current()).toBe("a");
  });

  it("reset() returns to the first proxy", async () => {
    const rotator = new ProxyRotator(["a", "b", "c"]);
    const fn = vi.fn(async (p: string) => {
      if (p === "a") throw new Error("down");
      return `ok:${p}`;
    });

    await rotator.call(fn);
    expect(rotator.current()).toBe("b");

    rotator.reset();
    expect(rotator.current()).toBe("a");
  });
});
