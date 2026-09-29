import { getChatDb, isChatDbReady } from '@/shared/lib/local-db';

/**
 * Why messages on this device could not be decrypted, for a bug report.
 *
 * «Приходят зашифрованные сообщения» reports (forta-bugs #1369, #1372, #1373, #1385, #1301 …)
 * carried nothing about encryption, so none of them could be told apart: a missing room
 * key, a peer without published keys and a timed-out key load all read the same to the
 * user. The decryption queue already keeps the reason of every failure; this sums it up.
 * Counts and error texts only — no message content, and ids are cut out of the errors.
 */
export interface BugReportEncryptionDiagnostics {
  /** Jobs by status: queued, processing, waiting (will retry), dead (gave up). */
  queue: Record<string, number>;
  /** Rooms with at least one job that is not done. */
  roomsAffected: number;
  /** The most frequent failure reasons, ids removed. */
  topErrors: Array<{ error: string; count: number }>;
  /** Age of the oldest unfinished job, in hours. */
  oldestHours: number;
}

export interface DecryptionJobLike {
  roomId: string;
  status: string;
  lastError?: string;
  createdAt: number;
}

const MAX_ERRORS = 5;
const MAX_ERROR_LENGTH = 90;

/** Event ids, Matrix ids, room ids, hashes and keys say nothing a triager needs and do not belong in a public issue. */
export function scrubDecryptionError(error: string): string {
  return error
    .replace(/[$!@#][^\s:]+:[\w.-]+/g, '<id>')
    .replace(/\$[\w+/=-]{10,}/g, '<id>')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '<hex>')
    .replace(/\b[\w+/=-]{24,}\b/g, '<token>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

/** Undefined when the queue is empty: a report with nothing to say stays short. */
export function summarizeDecryptionQueue(
  jobs: readonly DecryptionJobLike[],
  now: number,
): BugReportEncryptionDiagnostics | undefined {
  if (jobs.length === 0) return undefined;
  const queue: Record<string, number> = {};
  const rooms = new Set<string>();
  const errors = new Map<string, number>();
  let oldest = now;
  for (const job of jobs) {
    queue[job.status] = (queue[job.status] ?? 0) + 1;
    rooms.add(job.roomId);
    if (job.createdAt < oldest) oldest = job.createdAt;
    if (job.lastError) {
      const error = scrubDecryptionError(job.lastError);
      errors.set(error, (errors.get(error) ?? 0) + 1);
    }
  }
  const topErrors = [...errors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ERRORS)
    .map(([error, count]) => ({ error, count }));
  return { queue, roomsAffected: rooms.size, topErrors, oldestHours: Math.round((now - oldest) / 3_600_000) };
}

/** Never throws: a report must go out even when the local database is not there. */
export async function collectEncryptionDiagnostics(): Promise<BugReportEncryptionDiagnostics | undefined> {
  try {
    if (!isChatDbReady()) return undefined;
    const jobs = await getChatDb().db.decryptionQueue.toArray();
    return summarizeDecryptionQueue(jobs, Date.now());
  } catch {
    return undefined;
  }
}
