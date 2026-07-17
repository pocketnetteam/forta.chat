import { describe, it, expect, vi } from "vitest";
import {
  fetchCaptchaWithProxyFallback,
  type CaptchaResult,
  type FetchCaptchaWithFallbackDeps,
} from "../registration-captcha";

const captcha = (id: string): CaptchaResult => ({ id, img: "<svg/>", done: false });

describe("fetchCaptchaWithProxyFallback (WEE-23 registration proxy fallback)", () => {
  it("uses the already-pinned proxy without re-picking when it succeeds", async () => {
    // Arrange
    const pickProxy = vi.fn(async () => "proxy-B");
    const getCaptcha = vi.fn(async () => captcha("c1"));
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => "proxy-A",
      pickProxy,
      getCaptcha,
    };

    // Act
    const result = await fetchCaptchaWithProxyFallback(deps);

    // Assert
    expect(result.id).toBe("c1");
    expect(getCaptcha).toHaveBeenCalledOnce();
    expect(getCaptcha).toHaveBeenCalledWith("proxy-A");
    expect(pickProxy).not.toHaveBeenCalled();
  });

  it("picks a proxy first when none is pinned yet", async () => {
    // Arrange
    const pickProxy = vi.fn(async () => "proxy-A");
    const getCaptcha = vi.fn(async () => captcha("c1"));
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => null,
      pickProxy,
      getCaptcha,
    };

    // Act
    const result = await fetchCaptchaWithProxyFallback(deps);

    // Assert
    expect(result.id).toBe("c1");
    expect(pickProxy).toHaveBeenCalledOnce();
    expect(getCaptcha).toHaveBeenCalledOnce();
    expect(getCaptcha).toHaveBeenCalledWith("proxy-A");
  });

  it("rotates to the next proxy when the first proxy fetch fails (A1/A3)", async () => {
    // Arrange — proxy-A is blocked (rejects / times out), proxy-B is healthy
    const pickProxy = vi.fn(async () => "proxy-B");
    const getCaptcha = vi.fn(async (proxyId: string) => {
      if (proxyId === "proxy-A") throw new Error("proxywithwallet timed out after 15000ms");
      return captcha("c2");
    });
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => "proxy-A",
      pickProxy,
      getCaptcha,
    };

    // Act
    const result = await fetchCaptchaWithProxyFallback(deps);

    // Assert — fell back to a fresh proxy and succeeded
    expect(result.id).toBe("c2");
    expect(pickProxy).toHaveBeenCalledOnce();
    expect(getCaptcha).toHaveBeenNthCalledWith(1, "proxy-A");
    expect(getCaptcha).toHaveBeenNthCalledWith(2, "proxy-B");
  });

  it("rotates when the proxy answers with no captcha (null result)", async () => {
    // Arrange — proxy-A returns null (answered but empty), proxy-B returns a captcha
    const pickProxy = vi.fn(async () => "proxy-B");
    const getCaptcha = vi.fn(async (proxyId: string) =>
      proxyId === "proxy-A" ? null : captcha("c3"),
    );
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => "proxy-A",
      pickProxy,
      getCaptcha,
    };

    // Act
    const result = await fetchCaptchaWithProxyFallback(deps);

    // Assert
    expect(result.id).toBe("c3");
    expect(pickProxy).toHaveBeenCalledOnce();
  });

  it("rotates when the proxy returns a malformed captcha (no id)", async () => {
    // Arrange — proxy-A answers with a body that has no id, proxy-B is healthy
    const pickProxy = vi.fn(async () => "proxy-B");
    const getCaptcha = vi.fn(async (proxyId: string) =>
      proxyId === "proxy-A"
        ? ({ done: true } as unknown as CaptchaResult)
        : captcha("c4"),
    );
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => "proxy-A",
      pickProxy,
      getCaptcha,
    };

    // Act
    const result = await fetchCaptchaWithProxyFallback(deps);

    // Assert
    expect(result.id).toBe("c4");
    expect(pickProxy).toHaveBeenCalledOnce();
  });

  it("throws when the fallback proxy also fails (A2 — all proxies exhausted)", async () => {
    // Arrange — every proxy is blocked
    const pickProxy = vi.fn(async () => "proxy-B");
    const getCaptcha = vi.fn(async () => {
      throw new Error("getCaptcha timed out after 15000ms");
    });
    const deps: FetchCaptchaWithFallbackDeps = {
      getProxyId: () => "proxy-A",
      pickProxy,
      getCaptcha,
    };

    // Act + Assert — surfaces an error so the UI shows typed error + retry
    await expect(fetchCaptchaWithProxyFallback(deps)).rejects.toThrow();
    // One initial attempt + one fallback attempt only (bounded, no infinite loop)
    expect(getCaptcha).toHaveBeenCalledTimes(2);
    expect(pickProxy).toHaveBeenCalledOnce();
  });
});
