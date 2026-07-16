/**
 * Video bubble helpers — WEE-32 (forta-bugs#788, #789).
 *
 * Two small, pure-ish utilities that let MessageBubble render Telegram-style
 * video previews: a duration badge and a generated first-frame poster.
 */

/** Format duration in seconds as "M:SS" or "H:MM:SS" — Telegram-style.
 *  Returns an empty string for invalid/unknown durations so callers can
 *  conditionally hide the badge instead of showing "NaN:NaN". */
export function formatVideoDuration(seconds: number | undefined | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, "0");
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

interface ExtractOptions {
  /** Where to seek before grabbing the frame. Defaults to 0.1s so we skip
   *  the leading black frame some encoders emit. Clamped to `duration - 0.1`. */
  seekSeconds?: number;
  /** JPEG quality, 0..1. Defaults to 0.8 — small enough to keep memory low
   *  but still readable in a chat bubble. */
  quality?: number;
  /** Longest side of the resulting thumbnail in CSS pixels. Defaults to 640. */
  maxDimension?: number;
}

/** Extract a first-frame JPEG poster from a video URL and return a blob: URL
 *  to the result. Resolves with `null` (never rejects) on any failure — the
 *  caller falls back to the native HTML5 placeholder.
 *
 *  Caller owns the returned blob URL and must `URL.revokeObjectURL` it when
 *  the thumbnail is no longer needed. */
export async function extractVideoFrameThumbnail(
  videoUrl: string,
  options: ExtractOptions = {},
): Promise<string | null> {
  const seekSeconds = options.seekSeconds ?? 0.1;
  const quality = options.quality ?? 0.8;
  const maxDimension = options.maxDimension ?? 640;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try { video.removeAttribute("src"); } catch { /* ignore */ }
      try { video.load(); } catch { /* ignore */ }
      resolve(value);
    };

    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.playsInline = true;

    const onError = () => finish(null);

    const onSeeked = () => {
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
          finish(null);
          return;
        }
        const longest = Math.max(width, height);
        const scale = longest > maxDimension ? maxDimension / longest : 1;
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              finish(null);
              return;
            }
            try {
              finish(URL.createObjectURL(blob));
            } catch {
              finish(null);
            }
          },
          "image/jpeg",
          quality,
        );
      } catch {
        finish(null);
      }
    };

    const onLoadedData = () => {
      try {
        const safeDuration = Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : seekSeconds + 1;
        const target = Math.min(seekSeconds, Math.max(0, safeDuration - 0.1));
        video.currentTime = target;
      } catch {
        finish(null);
      }
    };

    video.addEventListener("error", onError, { once: true });
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });

    try {
      video.src = videoUrl;
    } catch {
      finish(null);
    }
  });
}
