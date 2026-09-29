/**
 * Background closing of holes in a room's stored history (plan
 * docs/plans/2026-09-28-chat-open-local-first.md, stage 3).
 *
 * A limited /sync leaves Dexie with older history, a hole, and the newest
 * events. The room remembers the hole as a `/messages` token (LocalRoom
 * .gapToken); this queue pages back from it, one room at a time, until a page
 * reaches history Dexie already has. The active room goes first. Chat
 * specifics (parsing, Dexie, the SDK) come in through `startPass`, so the
 * queue itself is testable with fakes.
 */

export interface BackfillPage {
  chunk: Record<string, unknown>[];
  /** Token for the next (older) page; null = start of the room. */
  end: string | null;
}

/** One pass over a room, prepared by the store. */
export interface BackfillPass {
  /** Where to page back from; null = nothing to page (no hole). */
  token: string | null;
  fetchPage: (token: string) => Promise<BackfillPage>;
  /** Parse and write the page; true when it reached history Dexie has. */
  ingestPage: (chunk: Record<string, unknown>[]) => Promise<boolean>;
  /** Persist progress: the next token, or null once the hole is closed. */
  saveToken: (token: string | null) => Promise<void>;
}

export interface HistoryBackfillDeps {
  /** False while the first sync runs (must not compete with it) or offline. */
  canRun: () => boolean;
  /** Writes what the SDK already holds in memory, then reports the hole. */
  startPass: (roomId: string) => Promise<BackfillPass>;
  /** The room being worked on changed (null = idle). */
  onActiveChange?: (roomId: string | null) => void;
  /** A pass over the room ended; `finished` = the hole is closed (not
   *  paused at the page limit, not failed). */
  onPassEnd?: (roomId: string, info: { finished: boolean }) => void;
  maxPagesPerPass?: number;
  /** Failed passes in a row before the room is left alone for the session
   *  (an expired token or a 403 never succeeds). Enqueue resets the count. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

export interface HistoryBackfill {
  /** Queue a room; `front` puts it first (the room the user opened). */
  enqueue: (roomId: string, opts?: { front?: boolean }) => void;
  /** Re-check the queue, e.g. once the first sync finished. */
  kick: () => void;
  /** Resolves when the queue is empty and nothing runs (tests). */
  whenIdle: () => Promise<void>;
  stop: () => void;
}

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function createHistoryBackfill(deps: HistoryBackfillDeps): HistoryBackfill {
  const maxPages = deps.maxPagesPerPass ?? DEFAULT_MAX_PAGES;
  const baseDelay = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = deps.random ?? Math.random;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const queue: string[] = [];
  const failures = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let running = false;
  let stopped = false;
  let idleWaiters: Array<() => void> = [];

  const notifyIdle = () => {
    if (running || queue.length > 0 || retryTimers.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  /** Exponential backoff with jitter, as SyncEngine does. */
  const retryDelay = (attempt: number): number => {
    const exp = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
    return exp / 2 + (exp / 2) * random();
  };

  /** One pass: true = the room needs another pass (page limit hit). */
  const runPass = async (roomId: string): Promise<boolean> => {
    const pass = await deps.startPass(roomId);
    let token = pass.token;
    for (let pages = 0; token && pages < maxPages; pages++) {
      if (stopped) return false;
      const page = await pass.fetchPage(token);
      const reachedStored = await pass.ingestPage(page.chunk);
      token = reachedStored || !page.end ? null : page.end;
      await pass.saveToken(token);
    }
    return !!token;
  };

  const pump = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length > 0 && deps.canRun()) {
        const roomId = queue.shift()!;
        deps.onActiveChange?.(roomId);
        let finished = false;
        try {
          const more = await runPass(roomId);
          finished = !more;
          failures.delete(roomId);
          if (more && !queue.includes(roomId)) queue.push(roomId);
        } catch (e) {
          const attempt = (failures.get(roomId) ?? 0) + 1;
          failures.set(roomId, attempt);
          console.warn("[history-backfill] pass failed for %s (attempt %d):", roomId, attempt, e);
          if (attempt < maxAttempts) scheduleRetry(roomId, retryDelay(attempt));
        } finally {
          deps.onPassEnd?.(roomId, { finished });
        }
      }
    } finally {
      running = false;
      deps.onActiveChange?.(null);
      notifyIdle();
    }
  };

  const scheduleRetry = (roomId: string, delayMs: number) => {
    if (retryTimers.has(roomId)) return;
    retryTimers.set(roomId, setTimeout(() => {
      retryTimers.delete(roomId);
      if (stopped) return;
      if (!queue.includes(roomId)) queue.push(roomId);
      void pump();
    }, delayMs));
  };

  const enqueue = (roomId: string, opts?: { front?: boolean }) => {
    if (stopped) return;
    // An explicit request (new hole, room opened) earns a fresh set of attempts.
    if (!retryTimers.has(roomId)) failures.delete(roomId);
    const at = queue.indexOf(roomId);
    if (opts?.front) {
      if (at > 0) queue.splice(at, 1);
      if (at !== 0) queue.unshift(roomId);
      // The user is looking at it: don't make them wait out a backoff.
      const timer = retryTimers.get(roomId);
      if (timer) {
        clearTimeout(timer);
        retryTimers.delete(roomId);
      }
    } else if (at === -1) {
      queue.push(roomId);
    }
    void pump();
  };

  return {
    enqueue,
    kick: () => { void pump(); },
    whenIdle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        notifyIdle();
      }),
    stop: () => {
      stopped = true;
      queue.length = 0;
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
      notifyIdle();
    },
  };
}
