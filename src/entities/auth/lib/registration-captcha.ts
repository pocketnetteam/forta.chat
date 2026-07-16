/** Captcha fetch with transparent proxy fallback for registration step 2 (WEE-23).
 *
 *  Why: the captcha is fetched from a single pinned Pocketnet proxy
 *  (`N.pocketnet.app:8899`). When that node is blocked/unreachable (RU ISP
 *  filtering — same root cause as WEE-13) the request fails (now bounded by a
 *  15s timeout in app-initializer) and the user is stuck on the captcha step
 *  with no recovery. This routes around a dead node: try the pinned proxy first
 *  (or pick one if none yet), and on failure re-pick a fresh proxy once and
 *  retry — so a blocked `1.pocketnet.app` falls through to the next node
 *  instead of dead-ending registration.
 */

export interface CaptchaResult {
  id: string;
  img?: string;
  done?: boolean;
}

export interface FetchCaptchaWithFallbackDeps {
  /** Currently pinned proxy id, or null if none has been selected yet. */
  getProxyId: () => string | null;
  /** Pick a fresh registration proxy (rotates to a different node) and return
   *  its id. Implementations should also clear any in-flight captcha session,
   *  since a new proxy issues a new captcha. */
  pickProxy: () => Promise<string>;
  /** Fetch a captcha from the given proxy. Resolves null when the proxy
   *  answered but returned no captcha — treated as a failure so we rotate. */
  getCaptcha: (proxyId: string) => Promise<CaptchaResult | null>;
}

/** Fetch a captcha, rotating to a fresh proxy when the current one is
 *  blocked/unreachable. Tries the pinned proxy first (picking one if absent),
 *  and on failure re-picks a proxy once and retries. Throws when the fallback
 *  proxy also fails, so the caller can surface a typed error + retry UX. */
export async function fetchCaptchaWithProxyFallback(
  deps: FetchCaptchaWithFallbackDeps,
): Promise<CaptchaResult> {
  const attempt = async (proxyId: string): Promise<CaptchaResult> => {
    const result = await deps.getCaptcha(proxyId);
    // A missing result OR a malformed one without an id (a dead/odd proxy can
    // answer with an empty body) is a failure — rotate rather than pin a
    // bogus captcha session that submitCaptcha would later reject.
    if (!result || !result.id) throw new Error("Failed to fetch captcha");
    return result;
  };

  const initialProxy = deps.getProxyId() ?? (await deps.pickProxy());
  try {
    return await attempt(initialProxy);
  } catch {
    // Current proxy blocked/timed out — rotate to a fresh node and retry once.
    const fallbackProxy = await deps.pickProxy();
    return await attempt(fallbackProxy);
  }
}
