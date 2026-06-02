import { Capacitor } from "@capacitor/core";

/**
 * Open an external URL the right way per platform.
 *
 * Capacitor's Android WebView treats `window.open(url, "_blank")` as a no-op
 * (there is no concept of a new tab), so on native we route through
 * `@capacitor/browser` which launches a Custom Tab / SFSafariViewController.
 * Everywhere else (web / Electron) we fall back to `window.open`. This mirrors
 * the link-handling fix from WEE-42 (MessageContent) so meeting links open
 * reliably on every supported Android device.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch (err) {
    // Plugin missing / rejected — try the web path as a last resort. It may
    // no-op on Android, but it does no harm and helps on misconfigured builds.
    console.error("[openExternalUrl] Browser.open failed, falling back:", err);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
