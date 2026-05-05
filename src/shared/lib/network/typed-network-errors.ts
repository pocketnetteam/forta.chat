/**
 * Typed errors for the media + crypto download path.
 *
 * The download pipeline used to throw bare `Error("Failed to fetch")` /
 * `Error("No room crypto for decryption")` strings, which the UI then had to
 * pattern-match. That fan-out made it impossible to surface different UX for
 * "media is gone forever" vs. "you're behind a region block" vs. "crypto
 * hasn't initialised yet, just wait". Each kind has a different recovery:
 *
 *  - `MediaUnavailableError` — exhausted retries against the homeserver. The
 *    blob may have been redacted, the server is permanently 404/410, or the
 *    CDN dropped the object. Tell the user the media is unavailable.
 *  - `NetworkBlockedError`  — fetch never reached the server (Failed to fetch
 *    / NetworkError / ERR_INTERNET_DISCONNECTED). Almost always means
 *    region/firewall block or full offline. Suggest Tor / VPN.
 *  - `CryptoNotReadyError`  — `authStore.pcrypto.rooms[roomId]` wasn't ready
 *    when we tried to decrypt. Caller should wait briefly and retry; this is
 *    a startup race, not a permanent failure.
 */

/** Heuristic patterns that indicate the request never reached the server.
 *  Browser-dependent — Chrome ships "Failed to fetch", Firefox "NetworkError
 *  when attempting to fetch resource", Safari "Load failed", Capacitor
 *  WebView "Network request failed", and Chromium surfaces
 *  `ERR_INTERNET_DISCONNECTED` when offline. All four browsers raise the
 *  same TypeError kind for region/firewall blocks; we want them to map
 *  to NetworkBlockedError uniformly so the iOS/Safari user sees the
 *  "try Tor or VPN" message just like the Android user does. */
const NETWORK_BLOCKED_PATTERNS: RegExp[] = [
  /failed to fetch/i,
  /network ?error/i,
  /network request failed/i,
  /err_internet_disconnected/i,
  // \b word-boundary so this matches Safari's "Load failed" but NOT
  // overlapping substrings like our internal "Download failed: 503"
  // (which is a 5xx HTTP response, not a region-block).
  /\bload failed\b/i,
];

export class MediaUnavailableError extends Error {
  readonly mxcUrl: string;

  constructor(mxcUrl: string, cause?: unknown) {
    super(`Media unavailable: ${mxcUrl}`, cause !== undefined ? { cause } : undefined);
    this.name = "MediaUnavailableError";
    this.mxcUrl = mxcUrl;
  }
}

export class NetworkBlockedError extends Error {
  constructor(cause?: unknown) {
    super(
      "Network appears blocked (region/firewall/offline)",
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "NetworkBlockedError";
  }
}

export class CryptoNotReadyError extends Error {
  readonly roomId: string;

  constructor(roomId: string, cause?: unknown) {
    super(
      `Room crypto not initialised: ${roomId}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "CryptoNotReadyError";
    this.roomId = roomId;
  }
}

/** Detect "the request never made it to the server" failures. Returns false
 *  for HTTP 4xx/5xx responses (the request DID reach the server, the server
 *  just answered with an error). Non-Error values always return false — we
 *  don't want a stray string match to flip a generic exception into a
 *  blocked-network UX. */
export function isNetworkBlocked(error: unknown): boolean {
  if (error instanceof NetworkBlockedError) return true;
  if (!(error instanceof Error)) return false;
  return NETWORK_BLOCKED_PATTERNS.some((re) => re.test(error.message));
}
