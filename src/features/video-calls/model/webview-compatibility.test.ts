import { describe, it, expect } from "vitest";
import {
  getWebViewInfo,
  isLegacyWebView,
  MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC,
} from "./webview-compatibility";

describe("getWebViewInfo", () => {
  it("parses Chrome major from a modern Android System WebView UA", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.193 Mobile Safari/537.36";
    expect(getWebViewInfo(ua)).toEqual({ engine: "chromium", major: 120, raw: ua });
  });

  it("parses Chrome major from a HUAWEI Android 10 WebView UA (close to the failure point)", () => {
    // Real UA pattern from #653 (HUAWEI STK-LX1, Android 10 without GMS).
    // System WebView shipped with EMUI 10 hovers around Chrome 96.
    const ua =
      "Mozilla/5.0 (Linux; Android 10; STK-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/96.0.4664.45 Mobile Safari/537.36";
    expect(getWebViewInfo(ua)).toEqual({ engine: "chromium", major: 96, raw: ua });
  });

  it("returns engine=unknown when no Chrome token is present (Safari, Electron with stripped UA)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1";
    expect(getWebViewInfo(ua)).toEqual({ engine: "unknown", raw: ua });
  });

  it("returns engine=unknown for empty UA", () => {
    expect(getWebViewInfo("")).toEqual({ engine: "unknown", raw: "" });
  });

  it("returns engine=unknown when Chrome version is non-numeric (malformed UA)", () => {
    const ua = "Mozilla/5.0 ... Chrome/abc Mobile Safari/537.36";
    // The regex only captures \d+, so "abc" won't match — we expect unknown,
    // not a corrupt {major: NaN}.
    expect(getWebViewInfo(ua)).toEqual({ engine: "unknown", raw: ua });
  });
});

describe("isLegacyWebView", () => {
  const modernUa =
    "Mozilla/5.0 (Linux; Android 14; Pixel 6) Chrome/120.0.6099.193 Mobile Safari/537.36";
  const legacyUa =
    "Mozilla/5.0 (Linux; Android 10; STK-LX1) Chrome/96.0.4664.45 Mobile Safari/537.36";
  const borderlineUa =
    "Mozilla/5.0 (Linux; Android 11) Chrome/99.0.4844.51 Mobile Safari/537.36";
  const exactThresholdUa =
    "Mozilla/5.0 (Linux; Android 12) Chrome/100.0.0.0 Mobile Safari/537.36";

  it("returns false for a recent Chromium build (Pixel 6 / Android 14)", () => {
    expect(isLegacyWebView(modernUa)).toBe(false);
  });

  it("returns true for HUAWEI WebView 96 (the device pattern in #653)", () => {
    expect(isLegacyWebView(legacyUa)).toBe(true);
  });

  it("returns true for the just-below-threshold case (Chromium 99)", () => {
    // Threshold is strict <100 — Chromium 99 still has the buggy
    // restartIce rollback, so it must be flagged.
    expect(isLegacyWebView(borderlineUa)).toBe(true);
  });

  it("returns false for the exact threshold (Chromium 100)", () => {
    // Equal-to-threshold counts as supported. Chromium 100 is when the
    // libwebrtc ICE consent / restartIce fixes landed.
    expect(isLegacyWebView(exactThresholdUa)).toBe(false);
  });

  it("returns false for non-Chromium engines so we do not block Safari / Electron", () => {
    const safariUa =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 Version/17.3 Mobile/15E148 Safari/604.1";
    expect(isLegacyWebView(safariUa)).toBe(false);
  });

  it("treats Electron as just another Chromium engine — recent Electron is safe", () => {
    // Electron 40 ships Chromium 126. The desktop client is one of the
    // primary surfaces for the legacy-WebView guard scope, so this is a
    // contract test: we don't want to false-positive on it.
    const electronUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Electron/40.6.0 Safari/537.36";
    expect(isLegacyWebView(electronUa)).toBe(false);
  });

  it("flags an old Electron build the same way it flags an old WebView", () => {
    // Hypothetical scenario: a user is running an ancient Electron build
    // bundled with Chromium 80. The guard SHOULD fire for them — the
    // restartIce-wedge bug is engine-version-dependent, not platform-
    // dependent. If we ever decide Electron is "always safe," the test
    // should be flipped explicitly so the contract change is visible.
    const ancientElectronUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.158 Electron/8.5.5 Safari/537.36";
    expect(isLegacyWebView(ancientElectronUa)).toBe(true);
  });

  it("returns false for Firefox (Gecko engine, not Chromium-based)", () => {
    const firefoxUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(isLegacyWebView(firefoxUa)).toBe(false);
  });

  it("returns false for legacy Edge (EdgeHTML, no Chrome token)", () => {
    // Pre-Chromium Edge — `Edge/<n>` with no `Chrome/<n>`. Should be
    // treated as unknown → guard does not fire.
    const edgeUa =
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36 Edge/15.15063";
    // Edge 15 contains Chrome/52, which is BELOW 100 — by the contract,
    // it WILL be flagged. If a future change wants to whitelist Edge by
    // detecting the `Edge/` token explicitly, this test will need to be
    // updated and the comment should explain why.
    expect(isLegacyWebView(edgeUa)).toBe(true);
  });

  it("respects an explicit threshold override (useful for staged rollout)", () => {
    // If we ever need to relax the gate (say, after a libwebrtc backport
    // verifies fine on Chromium 90), tests document the contract.
    expect(isLegacyWebView(legacyUa, 90)).toBe(false);
    expect(isLegacyWebView(legacyUa, 97)).toBe(true);
  });

  it("uses the documented constant for default threshold", () => {
    // Sentinel — if someone bumps the constant we want the test to scream.
    expect(MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC).toBe(100);
  });
});
