import { describe, it, expect } from "vitest";
import {
  detectClientOs,
  detectCpuArch,
  clientOsToDownloadPlatform,
  sortPlatformsByDetection,
} from "./detect-client-os";

describe("detectClientOs", () => {
  it("detects Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    expect(detectClientOs(ua)).toBe("android");
  });

  it("detects iPhone", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    expect(detectClientOs(ua)).toBe("ios");
  });

  it("detects Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    expect(detectClientOs(ua)).toBe("windows");
  });

  it("detects macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(detectClientOs(ua)).toBe("macos");
  });

  it("detects Linux", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    expect(detectClientOs(ua)).toBe("linux");
  });

  it("detects Chrome OS as linux", () => {
    const ua =
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    expect(detectClientOs(ua)).toBe("linux");
  });
});

describe("clientOsToDownloadPlatform", () => {
  it("maps downloadable OSes and null for ios/other", () => {
    expect(clientOsToDownloadPlatform("windows")).toBe("windows");
    expect(clientOsToDownloadPlatform("android")).toBe("android");
    expect(clientOsToDownloadPlatform("ios")).toBeNull();
    expect(clientOsToDownloadPlatform("other")).toBeNull();
  });
});

describe("sortPlatformsByDetection", () => {
  it("puts detected platform first", () => {
    expect(sortPlatformsByDetection("linux")).toEqual([
      "linux",
      "windows",
      "macos",
      "android",
    ]);
  });

  it("keeps default order when null", () => {
    expect(sortPlatformsByDetection(null)).toEqual([
      "windows",
      "macos",
      "linux",
      "android",
    ]);
  });
});

describe("detectCpuArch", () => {
  it("detects arm64 Mac", () => {
    expect(detectCpuArch("Macintosh; arm64 Mac OS X")).toBe("arm");
  });

  it("detects Intel Mac", () => {
    expect(
      detectCpuArch(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15",
      ),
    ).toBe("x64");
  });
});
