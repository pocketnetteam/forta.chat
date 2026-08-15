export {
  detectClientOs,
  detectCpuArch,
  clientOsToDownloadPlatform,
  sortPlatformsByDetection,
  DOWNLOAD_PLATFORMS,
  type ClientOs,
  type DownloadPlatform,
} from "./detect-client-os";

export {
  matchReleaseAssets,
  type ReleaseAsset,
  type MatchedAssets,
} from "./match-release-assets";

export {
  fetchLatestRelease,
  resolvePlatformDownloadUrl,
  type LatestReleaseDownloads,
} from "./fetch-latest-release";

export { useLatestReleaseDownloads } from "./use-latest-release-downloads";
