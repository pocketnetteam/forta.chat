import { downloadLinks } from "@/shared/config/download-links";
import {
  matchReleaseAssets,
  type MatchedAssets,
  type ReleaseAsset,
} from "./match-release-assets";

export type LatestReleaseDownloads = {
  version: string;
  urls: MatchedAssets;
  /** True when assets came from the API; false when using page fallbacks only. */
  fromApi: boolean;
};

type GithubReleaseJson = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

/**
 * Fetch the latest GitHub release and map installers per platform.
 * On network/API failure returns empty urls + fromApi:false (caller uses
 * `downloadLinks.githubReleasesLatest` as href fallback).
 */
export async function fetchLatestRelease(
  userAgent?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestReleaseDownloads> {
  try {
    const res = await fetchImpl(downloadLinks.githubApiLatest, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { version: "", urls: {}, fromApi: false };
    }
    const data = (await res.json()) as GithubReleaseJson;
    const version = (data.tag_name ?? "").replace(/^v/, "");
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const urls = matchReleaseAssets(assets, userAgent);
    return { version, urls, fromApi: true };
  } catch {
    return { version: "", urls: {}, fromApi: false };
  }
}

/** Resolve a platform download URL or the releases page fallback. */
export function resolvePlatformDownloadUrl(
  urls: MatchedAssets,
  platform: keyof MatchedAssets,
): string {
  return urls[platform] ?? downloadLinks.githubReleasesLatest;
}
