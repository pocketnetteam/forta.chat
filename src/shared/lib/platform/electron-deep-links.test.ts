import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractDeepLinkFromArgv,
} = require("../../../../electron/deep-links.cjs") as {
  extractDeepLinkFromArgv: (argv: string[]) => string | null;
};

const ROOM = "!abcdef123:matrix.pocketnet.app";

describe("electron/deep-links.cjs extractDeepLinkFromArgv", () => {
  it("finds forta:// URL in argv", () => {
    expect(
      extractDeepLinkFromArgv([
        "electron.exe",
        `forta://room/${encodeURIComponent(ROOM)}`,
      ]),
    ).toBe(`forta://room/${encodeURIComponent(ROOM)}`);
  });

  it("finds https://forta.chat URL in argv", () => {
    const url = `https://forta.chat/join?room=${encodeURIComponent(ROOM)}`;
    expect(extractDeepLinkFromArgv(["app", url])).toBe(url);
  });

  it("returns null when no deep link is present", () => {
    expect(extractDeepLinkFromArgv(["electron.exe", "."])).toBeNull();
    expect(extractDeepLinkFromArgv([])).toBeNull();
  });

  it("ignores non-forta https hosts", () => {
    expect(
      extractDeepLinkFromArgv(["app", "https://evil.com/join?room=x"]),
    ).toBeNull();
  });
});
