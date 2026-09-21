/**
 * In-memory record of the /sync pipeline's health for bug reports.
 *
 * "Messages never arrive, in every chat, restart doesn't help" reports come
 * from Android with no data: the UI can't tell a dead /sync (network, host,
 * persisted SDK state) from events the SDK swallowed while processing a batch
 * (SyncUnexpectedError — the sync token is already advanced by then, so that
 * batch is lost for good). This recorder keeps just enough to split those
 * cases from a single report. Pure state + injected clock so it is unit-testable.
 */

const MAX_HOST_SWITCHES = 5;
const MAX_ERROR_TEXT = 300;

export interface SyncHostSwitch {
  from: string;
  to: string;
  reason: string;
  ageMs: number;
}

export interface SyncDiagnosticsLive {
  host: string;
  hasSyncToken: boolean;
  chatsReady: boolean;
  roomCount: number;
  online: boolean;
}

export interface SyncDiagnosticsSnapshot extends SyncDiagnosticsLive {
  lastState: string | null;
  lastStateAgeMs: number | null;
  /** Time since the last PREPARED/SYNCING — null when never healthy this session. */
  lastHealthyAgeMs: number | null;
  healthyCount: number;
  /** ERROR states since the last healthy sync. */
  errorsSinceHealthy: number;
  lastError: string | null;
  lastErrorAgeMs: number | null;
  /** Exceptions the SDK swallowed while processing a /sync batch (batch lost). */
  unexpectedErrorCount: number;
  lastUnexpectedError: string | null;
  lastUnexpectedErrorAgeMs: number | null;
  /** Live (non-pagination) Room.timeline events received this session. */
  timelineEventCount: number;
  lastTimelineEventAgeMs: number | null;
  /** Our own listener threw inside an SDK emit (caught, see matrix-client initEvents). */
  listenerErrorCount: number;
  lastListenerError: string | null;
  hostSwitches: SyncHostSwitch[];
}

/** Compact one-line description of an SDK / fetch / arbitrary error. */
export function describeSyncError(err: unknown): string {
  if (err === null || err === undefined) return "unknown";
  if (typeof err !== "object") return String(err).slice(0, MAX_ERROR_TEXT);
  const e = err as {
    name?: unknown;
    errcode?: unknown;
    httpStatus?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const parts: string[] = [];
  if (typeof e.errcode === "string" && e.errcode) parts.push(e.errcode);
  else if (typeof e.name === "string" && e.name) parts.push(e.name);
  if (typeof e.httpStatus === "number") parts.push(`HTTP ${e.httpStatus}`);
  if (typeof e.message === "string" && e.message) parts.push(e.message);
  const cause = e.cause as { message?: unknown } | undefined;
  if (cause && typeof cause.message === "string" && cause.message) {
    parts.push(`(cause: ${cause.message})`);
  }
  const text = parts.length > 0 ? parts.join(" ") : Object.prototype.toString.call(err);
  return text.slice(0, MAX_ERROR_TEXT);
}

export class SyncDiagnosticsRecorder {
  private lastState: string | null = null;
  private lastStateAt: number | null = null;
  private lastHealthyAt: number | null = null;
  private healthyCount = 0;
  private errorsSinceHealthy = 0;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private unexpectedErrorCount = 0;
  private lastUnexpectedError: string | null = null;
  private lastUnexpectedErrorAt: number | null = null;
  private timelineEventCount = 0;
  private lastTimelineEventAt: number | null = null;
  private listenerErrorCount = 0;
  private lastListenerError: string | null = null;
  private hostSwitches: Array<{ from: string; to: string; reason: string; at: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  recordSyncState(state: string, error?: unknown): void {
    const at = this.now();
    this.lastState = state;
    this.lastStateAt = at;
    if (state === "PREPARED" || state === "SYNCING") {
      this.lastHealthyAt = at;
      this.healthyCount += 1;
      this.errorsSinceHealthy = 0;
      return;
    }
    if (state === "ERROR") {
      this.errorsSinceHealthy += 1;
      if (error !== undefined) {
        this.lastError = describeSyncError(error);
        this.lastErrorAt = at;
      }
    }
  }

  recordUnexpectedError(error: unknown): void {
    this.unexpectedErrorCount += 1;
    this.lastUnexpectedError = describeSyncError(error);
    this.lastUnexpectedErrorAt = this.now();
  }

  recordTimelineEvent(): void {
    this.timelineEventCount += 1;
    this.lastTimelineEventAt = this.now();
  }

  recordListenerError(listener: string, error: unknown): void {
    this.listenerErrorCount += 1;
    this.lastListenerError = `${listener}: ${describeSyncError(error)}`;
  }

  recordHostSwitch(from: string, to: string, reason: string): void {
    this.hostSwitches.push({ from, to, reason, at: this.now() });
    if (this.hostSwitches.length > MAX_HOST_SWITCHES) this.hostSwitches.shift();
  }

  snapshot(live: SyncDiagnosticsLive): SyncDiagnosticsSnapshot {
    const now = this.now();
    const age = (at: number | null): number | null => (at === null ? null : now - at);
    return {
      ...live,
      lastState: this.lastState,
      lastStateAgeMs: age(this.lastStateAt),
      lastHealthyAgeMs: age(this.lastHealthyAt),
      healthyCount: this.healthyCount,
      errorsSinceHealthy: this.errorsSinceHealthy,
      lastError: this.lastError,
      lastErrorAgeMs: age(this.lastErrorAt),
      unexpectedErrorCount: this.unexpectedErrorCount,
      lastUnexpectedError: this.lastUnexpectedError,
      lastUnexpectedErrorAgeMs: age(this.lastUnexpectedErrorAt),
      timelineEventCount: this.timelineEventCount,
      lastTimelineEventAgeMs: age(this.lastTimelineEventAt),
      listenerErrorCount: this.listenerErrorCount,
      lastListenerError: this.lastListenerError,
      hostSwitches: this.hostSwitches.map((s) => ({
        from: s.from,
        to: s.to,
        reason: s.reason,
        ageMs: now - s.at,
      })),
    };
  }
}
