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
 * Semantics: an `undefined` field means "caller didn't touch this — leave
 * Matrix alone"; an empty string means "user explicitly cleared this field —
 * mirror the clear into Matrix" so peers don't see a stale name/avatar.
 */

/** Matrix homeserver upload limit. Synapse default is 50 MB; Pocketnet uploads
 *  cap avatars at 5 MB (see shared/lib/upload-image.ts), so we mirror that. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Subset of MatrixClientService used here — keeps the helper trivially testable. */
export interface MatrixProfileSync {
  setDisplayName(name: string): Promise<void>;
  uploadAvatar(blob: Blob): Promise<string>;
  setAvatarMxc(mxcUrl: string): Promise<void>;
}

export interface SyncProfileParams {
  name?: string;
  image?: string;
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
    try {
      await matrix.setAvatarMxc("");
    } catch (e) {
      console.warn("[profile] setAvatarMxc clear failed:", e);
    }
    return;
  }

  try {
    const response = await fetch(params.image);
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
