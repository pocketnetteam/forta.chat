import { describe, it, expect } from "vitest";
import { parseOsVersionFromUserAgent } from "../collect-environment";

/** Audit S10-07: every Electron bug report said "OS: n/a". */
describe("parseOsVersionFromUserAgent", () => {
  it("names the desktop OS an Electron or browser user agent carries", () => {
    expect(
      parseOsVersionFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) forta-chat/1.4.0 Chrome/144.0.0.0 Electron/40.8.5 Safari/537.36",
      ),
    ).toBe("Windows NT 10.0");
    expect(
      parseOsVersionFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Electron/40.8.5 Safari/537.36",
      ),
    ).toBe("macOS 10.15.7");
    expect(
      parseOsVersionFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Electron/40.8.5 Safari/537.36",
      ),
    ).toBe("Linux x86_64");
    expect(parseOsVersionFromUserAgent("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/120.0")).toBe("ChromeOS");
  });

  it("keeps the bare version for Android and iOS", () => {
    expect(
      parseOsVersionFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-A528B Build/UP1A.231005.007; wv) AppleWebKit/537.36 Chrome/151.0 Mobile Safari/537.36",
      ),
    ).toBe("14");
    expect(
      parseOsVersionFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toBe("17.4");
    expect(parseOsVersionFromUserAgent("Mozilla/5.0 (iPad; CPU OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15")).toBe(
      "16.7.2",
    );
  });

  it("is empty for an agent it cannot read", () => {
    expect(parseOsVersionFromUserAgent("")).toBe("");
    expect(parseOsVersionFromUserAgent("curl/8.4.0")).toBe("");
  });
});
