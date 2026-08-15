import type { DownloadPlatform } from "./detect-client-os";
import { detectCpuArch } from "./detect-client-os";

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type MatchedAssets = Partial<Record<DownloadPlatform, string>>;

function isBlockmapOrYml(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".blockmap") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".yaml")
  );
}

function pickWindows(assets: ReleaseAsset[]): string | undefined {
  const exe = assets.find(
    (a) =>
      !isBlockmapOrYml(a.name) &&
      /-win-/i.test(a.name) &&
      a.name.toLowerCase().endsWith(".exe"),
  );
  return exe?.browser_download_url;
}

function pickMacos(
  assets: ReleaseAsset[],
  userAgent?: string,
): string | undefined {
  const dmgs = assets.filter(
    (a) =>
      !isBlockmapOrYml(a.name) &&
      /-mac-/i.test(a.name) &&
      a.name.toLowerCase().endsWith(".dmg"),
  );
  if (dmgs.length === 0) return undefined;
  if (dmgs.length === 1) return dmgs[0].browser_download_url;

  const arch = userAgent ? detectCpuArch(userAgent) : "unknown";
  if (arch === "arm") {
    const arm = dmgs.find((a) => /arm64|aarch64/i.test(a.name));
    if (arm) return arm.browser_download_url;
  }
  if (arch === "x64") {
    const x64 = dmgs.find((a) => /x64|x86_64|amd64/i.test(a.name) && !/arm/i.test(a.name));
    if (x64) return x64.browser_download_url;
  }
  return dmgs[0].browser_download_url;
}

function pickLinux(assets: ReleaseAsset[]): string | undefined {
  const appImage = assets.find(
    (a) =>
      !isBlockmapOrYml(a.name) &&
      a.name.toLowerCase().endsWith(".appimage"),
  );
  if (appImage) return appImage.browser_download_url;

  const deb = assets.find(
    (a) =>
      !isBlockmapOrYml(a.name) &&
      /-linux-/i.test(a.name) &&
      a.name.toLowerCase().endsWith(".deb"),
  );
  return deb?.browser_download_url;
}

function pickAndroid(assets: ReleaseAsset[]): string | undefined {
  const apk = assets.find(
    (a) =>
      !isBlockmapOrYml(a.name) &&
      a.name.toLowerCase().endsWith(".apk") &&
      !a.name.toLowerCase().endsWith(".aab"),
  );
  return apk?.browser_download_url;
}

/**
 * Match GitHub release assets to download platforms by filename conventions.
 * Optional `userAgent` helps pick macOS arch when multiple dmgs exist.
 */
export function matchReleaseAssets(
  assets: ReleaseAsset[],
  userAgent?: string,
): MatchedAssets {
  const result: MatchedAssets = {};
  const windows = pickWindows(assets);
  const macos = pickMacos(assets, userAgent);
  const linux = pickLinux(assets);
  const android = pickAndroid(assets);
  if (windows) result.windows = windows;
  if (macos) result.macos = macos;
  if (linux) result.linux = linux;
  if (android) result.android = android;
  return result;
}
