import { describe, expect, it } from "vitest";
import { CHAT_SCRIPT_URLS } from "./loadChatScripts";

describe("loadChatScripts", () => {
  it("loads all boot scripts from local paths (no CDN)", () => {
    for (const url of CHAT_SCRIPT_URLS) {
      expect(url).not.toMatch(/^https?:\/\//);
      expect(url.startsWith("/") || url.startsWith("./")).toBe(true);
    }
  });

  it("vendors critical globals before pocketnet SDK chain", () => {
    const awaitUrls = CHAT_SCRIPT_URLS.slice(
      CHAT_SCRIPT_URLS.indexOf("/js/vendor/underscore-min.js"),
    );
    expect(awaitUrls[0]).toBe("/js/vendor/underscore-min.js");
    expect(awaitUrls[1]).toBe("/js/satolist");
  });
});
