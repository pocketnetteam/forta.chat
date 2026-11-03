/**
 * Best-effort Matrix profile sync after a Pocketnet UserInfo edit.
 *
 * forta.chat keeps Pocketnet blockchain as the authoritative profile source.
 * Matrix room state events (m.room.member.displayname, avatar_url) drive what
 * peers see in chat. Without this sync, peers fall back to a truncated wallet
 * address — see Session 45 issues #595, #591, #375, #368, #121.
 *
 * Failures must never block the calling Pocketnet save: we swallow them and
 * surface a console.warn so the user still sees a successful save.
 *
 * Name semantics: an `undefined` name means "caller didn't touch this — leave
 * Matrix alone"; an empty string means "user explicitly cleared the name —
 * mirror the clear into Matrix" so peers don't see a stale name.
 *
 * Avatar semantics (WEE-77, forta-bugs#954/#943/#976): an empty `image` is
 * NOT a clear by default. A profile re-sync routinely runs with no loaded
 * avatar (Pocketnet still propagating, transient empty RPC row, form opened
 * before userInfo settled) — treating that as a clear wiped valid avatars and
 * caused the "avatar flickers / can't re-set it" reports. So an empty `image`
 * means "no avatar to sync — leave Matrix's avatar untouched". A genuine
 * user-initiated clear must pass `clearAvatar: true` explicitly.
 */

/** Matrix homeserver upload limit. Synapse default is 50 MB; Pocketnet uploads
 *  cap avatars at 5 MB (see shared/lib/upload-image.ts), so we mirror that. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Longest wait for the avatar bytes. They come from the image server the
 *  user just uploaded to (pocketnet.app:8092, often slow or silent), and the
 *  fetch had no limit at all (audit S6-03). */
export const AVATAR_FETCH_TIMEOUT_MS = 30_000;

/** fetch with a deadline that also aborts the request where AbortController
 *  exists. Not AbortSignal.timeout(): missing on the old WebViews we support. */
async function fetchWithDeadline(url: string, timeoutMs: number): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`avatar fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = fetch(url, controller ? { signal: controller.signal } : undefined);
  request.catch(() => undefined);
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Subset of MatrixClientService used here — keeps the helper trivially testable. */
export interface MatrixProfileSync {
  setDisplayName(name: string): Promise<void>;
  uploadAvatar(blob: Blob): Promise<string>;
  setAvatarMxc(mxcUrl: string): Promise<void>;
}

export interface SyncProfileParams {
  name?: string;
  image?: string;
  /** Explicit opt-in to mirror an avatar removal into Matrix. Only when this
   *  is `true` does an empty `image` trigger `setAvatarMxc("")`. Without it an
   *  empty `image` is a no-op so a stale/unloaded re-sync can't wipe a valid
   *  avatar (WEE-77). */
  clearAvatar?: boolean;
}

export async function syncProfileToMatrix(
  matrix: MatrixProfileSync,
  params: SyncProfileParams,
): Promise<void> {
  if (params.name !== undefined) {
    try {
      await matrix.setDisplayName(params.name);
    } catch (e) {
      console.warn("[profile] setDisplayName failed:", e);
    }
  }

  if (params.image === undefined) return;

  if (params.image === "") {
    // Guard: only an explicit user-clear wipes the Matrix avatar. An empty
    // image from an ordinary re-sync means "nothing to upload", not "remove
    // it" — see avatar semantics above (WEE-77).
    if (!params.clearAvatar) return;
    try {
      await matrix.setAvatarMxc("");
    } catch (e) {
      console.warn("[profile] setAvatarMxc clear failed:", e);
    }
    return;
  }

  try {
    const response = await fetchWithDeadline(params.image, AVATAR_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      console.warn("[profile] avatar fetch returned non-2xx:", response.status);
      return;
    }
    const blob = await response.blob();
    if (blob.size > MAX_AVATAR_BYTES) {
      console.warn("[profile] avatar exceeds Matrix size limit, skipping");
      return;
    }
    const mxc = await matrix.uploadAvatar(blob);
    await matrix.setAvatarMxc(mxc);
  } catch (e) {
    console.warn("[profile] Matrix avatar sync failed:", e);
  }
}
