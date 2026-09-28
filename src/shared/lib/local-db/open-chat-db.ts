import { withTimeout } from "@/shared/lib/with-timeout";

const OPEN_TIMEOUT_MS = 15_000;

/**
 * Open the local chat database explicitly, bounded in time (audit S3-04).
 * Dexie opens lazily, so a database that cannot open (no space, Safari private
 * mode, a corrupted store) failed out of sight and left an empty chat list; an
 * upgrade blocked by another tab never settles at all. Callers surface the
 * rejection to the user and retry the start.
 */
export async function openChatDb(
  db: { open(): Promise<unknown> },
  timeoutMs = OPEN_TIMEOUT_MS,
): Promise<void> {
  await withTimeout(db.open(), timeoutMs, "local database open");
}
