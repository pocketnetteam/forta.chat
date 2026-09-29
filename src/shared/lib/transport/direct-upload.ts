import { resolveUsesTor } from './init-transport';

/** Query flag the service worker reads to leave an upload to the network. */
export const DIRECT_UPLOAD_PARAM = 'forta_direct';

/**
 * The upload URL to POST to. Where a service worker answers the page's
 * requests (Android, Electron), it answers every one — and an
 * XMLHttpRequest whose body goes through respondWith() gets no upload
 * progress, so files sat at 0 % until they were sent. When the Tor routing
 * says this URL goes direct anyway, the URL carries a flag and the worker
 * lets it through. A URL that Tor claims, or an answer that fails, stays
 * as it was: the worker routes it as before.
 *
 * `usesTor` is the same question the worker asks; injectable for tests.
 */
export async function routeUploadUrl(
  url: string,
  usesTor: (url: string) => Promise<boolean> = resolveUsesTor,
): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return url;
  try {
    if (await usesTor(url)) return url;
  } catch {
    return url;
  }
  const direct = new URL(url);
  direct.searchParams.set(DIRECT_UPLOAD_PARAM, '1');
  return direct.toString();
}
