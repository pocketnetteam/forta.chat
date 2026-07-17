/**
 * Sync Pocketnet display name to Matrix after a successful client init.
 *
 * Only calls setDisplayName when the name differs from the last value we
 * pushed (cached in localStorage as `dsname_<userId>`). Failures are
 * swallowed so they never break the login/init flow.
 */

export interface MatrixDisplayNameSync {
  setDisplayName(name: string): Promise<void>;
}

export interface SyncDisplayNameParams {
  userId: string;
  name: string | undefined | null;
}

export async function syncDisplayNameAfterInit(
  matrix: MatrixDisplayNameSync,
  params: SyncDisplayNameParams,
): Promise<void> {
  const { userId, name } = params;
  if (!name) return;

  try {
    const cacheKey = `dsname_${userId}`;
    const cached = localStorage.getItem(cacheKey) ?? "";
    if (name !== cached) {
      localStorage.setItem(cacheKey, name);
      await matrix.setDisplayName(name);
    }
  } catch {
    // Errors must not break init
  }
}
