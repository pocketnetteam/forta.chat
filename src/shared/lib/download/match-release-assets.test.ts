import { describe, it, expect, vi } from "vitest";
import { matchReleaseAssets, type ReleaseAsset } from "./match-release-assets";
import {
  fetchLatestRelease,
  resolvePlatformDownloadUrl,
} from "./fetch-latest-release";
import { downloadLinks } from "@/shared/config/download-links";

const V1111_ASSETS: ReleaseAsset[] = [
  {
    name: "Forta-Chat-1.11.1-linux-amd64.deb",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-linux-amd64.deb",
  },
  {
    name: "Forta-Chat-1.11.1-linux-x86_64.AppImage",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-linux-x86_64.AppImage",
  },
  {
    name: "Forta-Chat-1.11.1-mac-arm64.dmg",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-mac-arm64.dmg",
  },
  {
    name: "Forta-Chat-1.11.1-mac-arm64.dmg.blockmap",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-mac-arm64.dmg.blockmap",
  },
  {
    name: "Forta-Chat-1.11.1-mac-arm64.zip",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-mac-arm64.zip",
  },
  {
    name: "Forta-Chat-1.11.1-win-x64.exe",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-win-x64.exe",
  },
  {
    name: "Forta-Chat-1.11.1-win-x64.exe.blockmap",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-win-x64.exe.blockmap",
  },
  {
    name: "Forta-Chat-1.11.1-win-x64.zip",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/Forta-Chat-1.11.1-win-x64.zip",
  },
  {
    name: "forta-chat-1.11.1.aab",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/forta-chat-1.11.1.aab",
  },
  {
    name: "forta-chat-1.11.1.apk",
    browser_download_url:
      "https://github.com/pocketnetteam/forta.chat/releases/download/v1.11.1/forta-chat-1.11.1.apk",
  },
];

describe("matchReleaseAssets", () => {
  it("matches v1.11.1 asset naming conventions", () => {
    const matched = matchReleaseAssets(V1111_ASSETS);
    expect(matched.windows).toContain("win-x64.exe");
    expect(matched.macos).toContain("mac-arm64.dmg");
    expect(matched.linux).toContain("AppImage");
    expect(matched.android).toContain(".apk");
    expect(matched.android).not.toContain(".aab");
  });

  it("prefers AppImage over deb for linux", () => {
    const matched = matchReleaseAssets(V1111_ASSETS);
    expect(matched.linux?.endsWith(".AppImage")).toBe(true);
  });

  it("ignores blockmaps and zips for windows/mac", () => {
    const matched = matchReleaseAssets(V1111_ASSETS);
    expect(matched.windows).not.toContain("blockmap");
    expect(matched.windows).not.toContain(".zip");
    expect(matched.macos).not.toContain(".zip");
  });

  it("returns empty object when no assets", () => {
    expect(matchReleaseAssets([])).toEqual({});
  });
});

describe("fetchLatestRelease", () => {
  it("parses API response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.11.1",
        assets: V1111_ASSETS,
      }),
    });
    const result = await fetchLatestRelease(undefined, fetchImpl);
    expect(result.fromApi).toBe(true);
    expect(result.version).toBe("1.11.1");
    expect(result.urls.android).toContain(".apk");
  });

  it("returns empty on network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await fetchLatestRelease(undefined, fetchImpl);
    expect(result).toEqual({ version: "", urls: {}, fromApi: false });
  });

  it("returns empty on non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const result = await fetchLatestRelease(undefined, fetchImpl);
    expect(result.fromApi).toBe(false);
    expect(result.urls).toEqual({});
  });
});

describe("resolvePlatformDownloadUrl", () => {
  it("returns matched url or releases page fallback", () => {
    expect(
      resolvePlatformDownloadUrl(
        { android: "https://example.com/app.apk" },
        "android",
      ),
    ).toBe("https://example.com/app.apk");
    expect(resolvePlatformDownloadUrl({}, "windows")).toBe(
      downloadLinks.githubReleasesLatest,
    );
  });
});
