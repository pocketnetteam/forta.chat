import { isNative } from "@/shared/lib/platform/index";

/**
 * Copy text to the clipboard with fallback for legacy Android WebView.
 *
 * Tier 1: `navigator.clipboard.writeText` — modern path (Android Chromium ≥66,
 *         iOS Safari 13.1+). Requires a secure context.
 * Tier 2: hidden `<textarea>` + `document.execCommand("copy")` — works on
 *         Android 7 WebView and iOS PWAs where the async Clipboard API is
 *         missing or blocked.
 *
 * We intentionally do NOT depend on `@capacitor/clipboard` because Capacitor's
 * WebView exposes `navigator.clipboard` directly; the execCommand fallback
 * covers the old-WebView cases that motivated this helper.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as any;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand
    }
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "absolute";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (document as any).execCommand?.("copy");
    if (!ok) throw new Error("execCommand_copy_failed");
  } finally {
    document.body.removeChild(ta);
  }
}

export interface ShareOptions {
  url: string;
  title?: string;
  text?: string;
}

/**
 * Open the system share sheet. Native → @capacitor/share; web → Web Share API.
 * Rejects with `share_unavailable` if neither is available — caller should
 * fall back to copyToClipboard and show a toast.
 */
export async function shareLink(opts: ShareOptions): Promise<void> {
  if (isNative) {
    const { Share } = await import("@capacitor/share");
    await Share.share({
      url: opts.url,
      title: opts.title,
      text: opts.text,
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as any;
  if (typeof nav?.share === "function") {
    await nav.share({
      url: opts.url,
      title: opts.title,
      text: opts.text,
    });
    return;
  }

  throw new Error("share_unavailable");
}
