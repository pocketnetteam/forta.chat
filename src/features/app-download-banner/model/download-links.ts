/**
 * AppDownloadBanner — download link resolution.
 *
 * Pure helpers so they can be unit-tested without mounting the component.
 * The banner only renders on the *web* build (when the user is browsing
 * forta.chat from a mobile browser). For native shells the banner is
 * suppressed regardless of UA.
 *
 * iOS App Store ID is not minted yet (see
 * docs/plans/ios/2026-05-12-ios-simple-tasks.md Task 8) — we ship the
 * release page fallback until App Store Connect publishes the listing.
 */

/** Substring marker for the App Store URL; once minted, replace with the real id. */
export const IOS_APP_STORE_ID_PLACEHOLDER = 'idXXXXXXXX';

/**
 * iOS App Store URL.
 *
 * Falls back to the public release page until the iOS app is published.
 * Keep the `idXXXXXXXX` placeholder as a TODO marker so we can grep for it.
 */
export const IOS_APP_STORE_URL = `https://apps.apple.com/app/${IOS_APP_STORE_ID_PLACEHOLDER}`;

export const ANDROID_RELEASE_URL =
  'https://github.com/pocketnetteam/forta.chat/releases/latest';

export const WEB_DOWNLOAD_FALLBACK_URL = 'https://forta.chat/#/download';

export type BrowserPlatform = 'android' | 'ios' | 'other';

/**
 * Classify a browser User-Agent string into the platform we want to surface
 * a download banner for. Native shells short-circuit before this helper is
 * reached — it only looks at web UAs.
 */
export function detectBrowserPlatform(userAgent: string): BrowserPlatform {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  return 'other';
}

/**
 * Resolve the URL the banner's "Download" button should open for the given
 * detected browser platform. Unknown platforms get the website fallback —
 * the banner itself decides whether to render in the first place.
 */
export function resolveDownloadUrl(platform: BrowserPlatform): string {
  switch (platform) {
    case 'ios':
      // TODO(ios): replace IOS_APP_STORE_ID_PLACEHOLDER with the real
      // App Store ID once App Store Connect mints the listing. Until
      // then, send users to the release/landing page rather than a
      // broken Apple page.
      return IOS_APP_STORE_URL.includes(IOS_APP_STORE_ID_PLACEHOLDER)
        ? WEB_DOWNLOAD_FALLBACK_URL
        : IOS_APP_STORE_URL;
    case 'android':
      return ANDROID_RELEASE_URL;
    default:
      return WEB_DOWNLOAD_FALLBACK_URL;
  }
}
