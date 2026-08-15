/**
 * Client OS detection from a User-Agent string (web browsers).
 * Used by the apps download page and landing CTAs.
 */

export type ClientOs =
  | "windows"
  | "macos"
  | "linux"
  | "android"
  | "ios"
  | "other";

/** Downloadable desktop/mobile platforms shown on the apps page. */
export type DownloadPlatform = "windows" | "macos" | "linux" | "android";

export const DOWNLOAD_PLATFORMS: readonly DownloadPlatform[] = [
  "windows",
  "macos",
  "linux",
  "android",
] as const;

/**
 * Classify a browser User-Agent into a coarse client OS.
 * Order matters: Android/iOS before Linux/macOS (Android UAs contain "Linux";
 * iPadOS 13+ may report as Macintosh).
 */
export function detectClientOs(userAgent: string): ClientOs {
  const ua = userAgent;

  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS 13+ desktop mode: Macintosh + touch / mobile Safari hints
  if (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) return "ios";

  if (/Windows|Win64|Win32|WinCE/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/CrOS/i.test(ua) || /Linux/i.test(ua)) return "linux";

  return "other";
}

/**
 * Map detected OS to a downloadable platform for primary CTA.
 * iOS / other → null (caller falls back to list or Android).
 */
export function clientOsToDownloadPlatform(
  os: ClientOs,
): DownloadPlatform | null {
  switch (os) {
    case "windows":
    case "macos":
    case "linux":
    case "android":
      return os;
    default:
      return null;
  }
}

/**
 * Sort download platforms so the detected one comes first.
 */
export function sortPlatformsByDetection(
  detected: DownloadPlatform | null,
  platforms: readonly DownloadPlatform[] = DOWNLOAD_PLATFORMS,
): DownloadPlatform[] {
  if (!detected) return [...platforms];
  return [
    detected,
    ...platforms.filter((p) => p !== detected),
  ];
}

/** Prefer arm64 vs x64 from UA when matching mac assets. */
export function detectCpuArch(userAgent: string): "arm" | "x64" | "unknown" {
  if (/arm64|aarch64|Apple Silicon/i.test(userAgent)) return "arm";
  // Intel Mac / Windows x64 markers
  if (/Intel|x86_64|Win64|WOW64|amd64/i.test(userAgent)) return "x64";
  // Modern Macs without Intel in UA are usually Apple Silicon
  if (/Macintosh/i.test(userAgent) && !/Intel/i.test(userAgent)) return "arm";
  return "unknown";
}
