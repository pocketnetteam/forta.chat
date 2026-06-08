import type { ChatDatabase, PendingOperation, LocalMessage } from "./schema";
import type { MessageRepository } from "./message-repository";
import type { RoomRepository } from "./room-repository";
import { getMatrixClientService } from "@/entities/matrix";
import { ENCRYPTION_REQUIRED_NO_KEYS, type PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { withTimeout } from "@/shared/lib/with-timeout";

type GetRoomCryptoFn = (roomId: string) => Promise<PcryptoRoomInstance | undefined>;
type OnChangeCallback = (roomId: string) => void;

const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;

/** Re-check interval while the Matrix client is not ready (boot / re-init).
 *  A claimed send op is released back to "pending" WITHOUT counting a retry
 *  and re-polled at this cadence, so messages sent during the not-ready
 *  window queue up and flush once the client is ready instead of failing
 *  instantly or exhausting maxRetries during a slow boot (WEE-85). */
const MATRIX_NOT_READY_RETRY_MS = 1_000;

/** Outbound message-creating ops whose transport status is mirrored onto the
 *  room's `lastMessageLocalStatus` (chat-list preview, WEE-64). Edit/reaction/
 *  delete/vote ops mutate an existing message and must never overwrite the
 *  preview badge. */
const SEND_OPS: ReadonlySet<PendingOperation["type"]> = new Set([
  "send_message",
  "send_file",
  "send_transfer",
  "send_poll",
]);

/** Watchdog tick interval. The watchdog is a safety net for cases where the
 *  connectivity layer fails to deliver a "back online" signal — most commonly
 *  Android WebView after device sleep+wake, where `window.online` may never
 *  fire even though `navigator.onLine` has already flipped to true. Once per
 *  tick we look for stuck pending ops and resume the queue if the underlying
 *  network is actually available. */
const WATCHDOG_INTERVAL_MS = 30_000;

/** Per-phase media pipeline timeouts. Splitting one 5-minute cap into
 *  per-phase caps lets retries surface phase-specific failures (e.g. crypto
 *  hang vs. upload stall) instead of a generic "timed out" after 5 min. */
const MEDIA_ENCRYPT_TIMEOUT_MS = 30_000;
const MEDIA_UPLOAD_TIMEOUT_MS = 4 * 60_000;
const MEDIA_SEND_EVENT_TIMEOUT_MS = 20_000;

/** Throttle for upload-progress Dexie writes. A 20MB upload over a slow
 *  link produces hundreds of progress callbacks per second; unthrottled
 *  writes saturate the IDB lock on older Android WebViews. Always flush
 *  the terminal "100%" so the UI never sticks at 97%. */
const UPLOAD_PROGRESS_WRITE_INTERVAL_MS = 500;

function makeThrottledProgress(
  write: (percent: number) => void,
): (p: { loaded: number; total: number }) => void {
  let lastWriteAt = 0;
  let lastPercent = -1;
  return (progress) => {
    const percent =
      progress.total > 0
        ? Math.round((progress.loaded / progress.total) * 100)
        : 0;
    const now = Date.now();
    const isFinal = percent === 100 && lastPercent !== 100;
    if (!isFinal && now - lastWriteAt < UPLOAD_PROGRESS_WRITE_INTERVAL_MS) return;
    if (percent === lastPercent) return;
    lastWriteAt = now;
    lastPercent = percent;
    write(percent);
  };
}

function computeBackoff(retries: number): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** retries, MAX_BACKOFF_MS);
  return base + Math.random() * Math.min(base * 0.5, 5_000);
}

/** Short, in-attempt backoff for the upload sub-step (forta-bugs#831 /
 *  #725 / #423 / WEE-50). Network blips on flaky Android cell links lose
 *  the first POST to the media repo even when the rest of the pipeline is
 *  fine; without an in-line retry the whole op fails and the user waits
 *  out the engine-level 1-30s backoff. Three quick attempts cover the
 *  vast majority of single-packet drops within ~6 s before falling back
 *  to the queue-level retry logic. Delays kept in ms. */
const UPLOAD_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

/** Errors that the upload retry loop must NOT swallow. Aborts are user
 *  intent (cancelMediaUpload), and deterministic server-side failures are
 *  retry-immune — retrying just delays the failure UX. */
function isUploadFatal(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error) {
    // Matrix media repo returns 413 (payload too large) and 4xx auth/quota
    // failures that are not retryable. We don't have typed errors at this
    // layer, so substring-match the bare message — same approach the
    // download path takes. Matches only digit groups that look like an
    // HTTP-status mention (preceded by "status" or by start-of-message /
    // whitespace + non-digit) so a filename like `meeting_403.mp3` doesn't
    // poison the heuristic.
    if (/(?:status\s*|^|\s)(?:413|415|401|403)\b|too large|payload too large/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/** AbortSignal-aware sleep. Resolves after `ms` or rejects immediately on
 *  abort — the latter is important so `cancelMediaUpload` can interrupt the
 *  backoff between attempts instead of forcing the user to wait out the
 *  4-second tail. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wrap `matrixService.uploadContent` with short in-attempt retries.
 *  See `UPLOAD_RETRY_DELAYS_MS` for the rationale. Returns the mxc:// URL
 *  emitted by the final successful attempt. Throws the LAST error if every
 *  attempt fails so the engine-level retry loop can take over with its
 *  longer backoff.
 *
 *  Total: 1 initial attempt + UPLOAD_RETRY_DELAYS_MS.length retries. */
async function uploadWithRetry(
  upload: () => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    if (attempt > 0) {
      await sleep(UPLOAD_RETRY_DELAYS_MS[attempt - 1], signal);
    }
    try {
      return await upload();
    } catch (e) {
      lastErr = e;
      if (isUploadFatal(e)) throw e;
    }
  }
  throw lastErr;
}

/**
 * SyncEngine processes pending operations (outbound queue).
 *
 * Lifecycle:
 *   1. User action → MessageRepository writes to local DB + creates PendingOp
 *   2. SyncEngine.processQueue() picks up ops in FIFO order
 *   3. Each op: encrypt if needed → call Matrix API → update local message status
 *   4. On failure: exponential backoff + retry, or mark as "failed"
 *
 * The engine is connectivity-aware: `setOnline(false)` pauses processing,
 * `setOnline(true)` resumes.
 */
export class SyncEngine {
  private processing = false;
  private online = true;
  private scheduled = false;
  private disposed = false;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  /** Watchdog interval handle. Drains stuck queues even when no
   *  connectivity transition signal arrives (Android WebView sleep+wake). */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** AbortControllers for in-flight media uploads, keyed by clientId.
   *  Populated by syncSendFile at the start of each execution, drained in
   *  its finally block. cancelMediaUpload() signals through this map to
   *  abort a running upload mid-flight. */
  private activeUploads = new Map<string, AbortController>();
  /** Becomes true the first time setOnline() is called with `true`.
   *  Guards against the "app started offline from a previous session and
   *  wakes up online without ever seeing setOnline(false)" case, where
   *  wasOffline would be `false` and failed ops would never get retried. */
  private hasSeenFirstOnline = false;
  private getRoomCrypto: GetRoomCryptoFn;
  private onChange?: OnChangeCallback;

  constructor(
    private db: ChatDatabase,
    private messageRepo: MessageRepository,
    private roomRepo: RoomRepository,
    getRoomCrypto: GetRoomCryptoFn,
    onChange?: OnChangeCallback,
  ) {
    this.getRoomCrypto = getRoomCrypto;
    this.onChange = onChange;
    this.startWatchdog();
  }

  /** Update online/offline state. Resumes queue on reconnect and
   *  re-arms any operations that died as "failed" while we were offline so
   *  the user does not have to tap Retry manually after coming back online. */
  setOnline(isOnline: boolean): void {
    const wasOffline = !this.online;
    this.online = isOnline;
    if (!isOnline) return;

    // Trigger retryAllFailed on BOTH: the offline→online edge, AND the very
    // first online signal after construction. The second case matters because
    // this.online is initialized to `true` — so a fresh instance whose first
    // incoming signal is `setOnline(true)` would otherwise see wasOffline=false
    // and skip retrying any failed ops carried over from a previous session.
    const shouldRetry = wasOffline || !this.hasSeenFirstOnline;
    this.hasSeenFirstOnline = true;

    if (shouldRetry) {
      // Fire-and-forget — retryAllFailed itself calls processQueue().
      // NOTE: we intentionally do NOT call recoverStrandedOps() here because
      // it has a race with an already-in-flight processQueue() (it could
      // reset a "syncing" op that's mid-execution). recoverStrandedOps is
      // documented as "call once at startup before processQueue()" — callers
      // own that ordering.
      this.retryAllFailed().catch((e) => {
        console.warn("[SyncEngine] retryAllFailed on reconnect failed:", e);
        this.processQueue();
      });
    }
  }

  /**
   * Recover operations stranded in "syncing" state (e.g. after app crash mid-send).
   * Resets them back to "pending" so processQueue() will pick them up.
   * Must be called once at startup before processQueue().
   */
  async recoverStrandedOps(): Promise<void> {
    const stranded = await this.db.pendingOps
      .where("status")
      .equals("syncing")
      .toArray();

    if (stranded.length === 0) return;

    console.info(`[SyncEngine] Recovering ${stranded.length} stranded "syncing" ops`);

    for (const op of stranded) {
      await this.db.pendingOps.update(op.id!, {
        status: "pending",
        retries: 0,
      });
      // Also reset the associated message status so UI shows "sending" not stuck
      if (op.clientId) {
        await this.messageRepo.updateStatus({ clientId: op.clientId }, "pending");
      }
    }
  }

  /** Set the callback invoked after a successful sync operation */
  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  /**
   * Snapshot of the outbound queue used by the UI banner to detect stuck sends.
   *
   * `oldestPendingAgeMs` is `null` when the queue has no due ops. When it is
   * large the UI can warn the user that something is wedged — e.g. crypto
   * never resolved or media server is unreachable — instead of leaving them
   * staring at "sending…" forever.
   *
   * Why exposed as a polled snapshot and not a Dexie live-query:
   *  - The caller (status banner) is allowed to be eventually consistent;
   *    polling once every few seconds is cheaper than a hot live-query that
   *    fires on every progress write.
   *  - Keeps the SyncEngine's public surface minimal — Dexie tables are
   *    internal state.
   */
  async getQueueHealth(): Promise<{
    pendingCount: number;
    failedCount: number;
    syncingCount: number;
    oldestPendingAgeMs: number | null;
  }> {
    const [pending, failed, syncing] = await Promise.all([
      this.db.pendingOps.where("status").equals("pending").toArray(),
      this.db.pendingOps.where("status").equals("failed").count(),
      this.db.pendingOps.where("status").equals("syncing").count(),
    ]);
    const now = Date.now();
    let oldest: number | null = null;
    for (const op of pending) {
      const created = op.createdAt ?? op.lastAttemptAt ?? now;
      const age = now - created;
      if (oldest === null || age > oldest) oldest = age;
    }
    return {
      pendingCount: pending.length,
      failedCount: failed,
      syncingCount: syncing,
      oldestPendingAgeMs: oldest,
    };
  }

  // ---------------------------------------------------------------------------
  // Queue processing
  // ---------------------------------------------------------------------------

  /**
   * Process one op from the queue per tick, then yield to the event loop.
   * Re-schedules itself via setTimeout until the queue is empty or a retry
   * is not yet due. This prevents head-of-line blocking: a single failing op
   * cannot hold the queue for its 30s backoff.
   *
   * External callers use the public `processQueue()` which is a thin wrapper
   * kicking off the first tick without double-scheduling.
   */
  async processQueue(): Promise<void> {
    this.kickScheduler(0);
  }

  /**
   * Fully stop the engine: clear scheduled wake-up timers and refuse further
   * ticks. Intended for shutdown and tests.
   */
  dispose(): void {
    this.disposed = true;
    this.online = false;
    if (this.scheduledTimer !== null) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.scheduled = false;
  }

  // ---------------------------------------------------------------------------
  // Watchdog — last-resort recovery when no connectivity signal arrives
  // ---------------------------------------------------------------------------

  private startWatchdog(): void {
    if (this.watchdogTimer || this.disposed) return;
    this.watchdogTimer = setInterval(() => {
      if (this.disposed) return;
      this.watchdogCheck().catch((e) =>
        console.warn("[SyncEngine] watchdog tick failed:", e),
      );
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * Per-tick safety check. Three states matter:
   *  1. No queued work — nothing to do.
   *  2. Engine thinks it is offline but `navigator.onLine` is true — the
   *     connectivity transition was missed (Android sleep+wake bug);
   *     force `setOnline(true)` so retryAllFailed + processQueue run.
   *  3. Engine is online but scheduler is idle — probably a race where a
   *     wake-up timer was cleared; kick a fresh tick.
   */
  private async watchdogCheck(): Promise<void> {
    const pending = await this.db.pendingOps
      .where("status")
      .anyOf(["pending", "syncing"])
      .count();
    if (pending === 0) return;

    if (!this.online) {
      if (typeof navigator !== "undefined" && navigator.onLine) {
        console.info(
          `[SyncEngine] watchdog: ${pending} ops stuck while navigator.onLine=true, forcing setOnline(true)`,
        );
        this.setOnline(true);
      }
      return;
    }

    if (!this.scheduled && !this.processing) {
      this.kickScheduler(0);
    }
  }

  /** Schedule processTick after `delayMs` unless a tick is already pending. */
  private kickScheduler(delayMs: number): void {
    if (this.disposed || this.scheduled || this.processing || !this.online) return;
    this.scheduled = true;
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null;
      this.processTick();
    }, Math.max(0, delayMs));
  }

  private async processTick(): Promise<void> {
    this.scheduled = false;
    if (this.disposed || this.processing || !this.online) return;
    this.processing = true;

    let op: PendingOperation | null = null;
    let nextRetryDelay: number | null = null; // smallest remaining wait

    try {
      // Claim one due pending op transactionally so concurrent engines
      // (multi-tab) can't both pick the same record.
      op = await this.claimDueOp();

      if (!op) {
        // Nothing due right now — check whether an op is scheduled for later
        // so we can set a wake-up timer and then stop this tick cleanly.
        nextRetryDelay = await this.findNextRetryDelay();
        return;
      }

      // Matrix-readiness gate (WEE-85): during the boot / re-init window the
      // client object isn't ready (`isReady()` false). Sending now would throw
      // and burn a retry, so instead release the op back to "pending" WITHOUT
      // counting a retry and reschedule a short re-poll. The op flushes once
      // the client is ready — mirroring how `online` gates the whole loop.
      // Real failures still surface via maxRetries once the client is ready.
      // NOTE: recovery is intentionally poll-based (this 1s re-poll, backed by
      // the watchdog) — there is no `onReady` event that re-kicks the scheduler
      // when Matrix becomes ready.
      if (!this.isMatrixReady()) {
        await this.db.pendingOps.update(op.id!, {
          status: "pending",
          nextAttemptAt: Date.now() + MATRIX_NOT_READY_RETRY_MS,
        });
        op = null; // don't execute; finally schedules the re-poll wake
        nextRetryDelay = MATRIX_NOT_READY_RETRY_MS;
        return;
      }

      try {
        await this.executeOperation(op);
        // If dispose() was called while the send was in flight, skip writing
        // to a DB we no longer own. The send itself already landed server-side;
        // the next engine instance will reconcile via Matrix sync.
        if (this.disposed) return;
        await this.db.pendingOps.delete(op.id!);
        this.onChange?.(op.roomId);
      } catch (e) {
        if (this.disposed) return;

        // Race guard: Matrix may have accepted the event server-side even
        // though the SDK threw (read timeout, CORS race, etc.). When the
        // server-side `/sync` echo arrives via EventWriter → upsertFromServer
        // the local message picks up its eventId and flips to "synced"
        // before this catch runs. In that case the queued op is already
        // satisfied — drop it without flagging the message as failed,
        // otherwise the user sees a red retry indicator on a message the
        // peer actually received (WEE-40).
        if (op.clientId && (await this.isMessageAlreadyConfirmed(op.clientId))) {
          await this.db.pendingOps.delete(op.id!);
          this.onChange?.(op.roomId);
          return;
        }

        const retries = op.retries + 1;
        if (retries >= op.maxRetries) {
          await this.db.pendingOps.update(op.id!, {
            status: "failed",
            retries,
            errorMessage: String(e),
            lastAttemptAt: Date.now(),
          });
          await this.markMessageFailed(op);
          this.onChange?.(op.roomId);
        } else {
          const delay = computeBackoff(retries);
          await this.db.pendingOps.update(op.id!, {
            status: "pending",
            retries,
            lastAttemptAt: Date.now(),
            nextAttemptAt: Date.now() + delay,
          });
          // We don't `await sleep(delay)` here — other due ops must proceed
          // immediately. The delay is tracked via nextAttemptAt in the DB,
          // and a wake-up timer is scheduled in the finally block below.
        }
      }
    } finally {
      this.processing = false;
      if (this.online) {
        if (op) {
          // We just processed one op. Immediately yield and check for the
          // next due op. claimDueOp will skip any op whose nextAttemptAt is
          // still in the future.
          this.kickScheduler(0);
        } else if (nextRetryDelay !== null) {
          // Queue is empty of due ops but a retry is scheduled for later.
          // Set a single wake-up timer so that retry is actually attempted.
          this.scheduleWake(nextRetryDelay);
        }
      }
    }
  }

  /**
   * Atomically claim the next due pending op (status = "pending"
   * and nextAttemptAt <= now). Returns null if nothing is due.
   *
   * Uses the [status+nextAttemptAt] compound index added in v11 so this is
   * O(log n) even with thousands of queued ops. Freshly-enqueued ops get
   * nextAttemptAt=0 and are naturally prioritised over retry-scheduled ops
   * (which have larger nextAttemptAt values). Within the same nextAttemptAt
   * bucket Dexie falls back to the primary key order, which is creation
   * order for `++id` — preserving FIFO for fresh sends.
   */
  private async claimDueOp(): Promise<PendingOperation | null> {
    return this.db.transaction("rw", this.db.pendingOps, async () => {
      const now = Date.now();
      const due = await this.db.pendingOps
        .where("[status+nextAttemptAt]")
        .between(["pending", -Infinity], ["pending", now], true, true)
        .first();
      if (!due) return null;
      await this.db.pendingOps.update(due.id!, { status: "syncing" });
      return { ...due, status: "syncing" };
    });
  }

  /**
   * Look at pending ops scheduled for the future and return the smallest
   * remaining wait (in ms). Used to set a wake-up timer when the queue has
   * no immediately-due work but will have work later. O(log n) via the
   * [status+nextAttemptAt] compound index — only reads the first future op.
   */
  private async findNextRetryDelay(): Promise<number | null> {
    const now = Date.now();
    const soonest = await this.db.pendingOps
      .where("[status+nextAttemptAt]")
      .above(["pending", now])
      .first();
    if (!soonest) return null;
    const delay = (soonest.nextAttemptAt ?? 0) - now;
    return delay > 0 ? delay : null;
  }

  /** Schedule a future tick to pick up retry-scheduled ops. */
  private scheduleWake(delayMs: number): void {
    this.kickScheduler(delayMs);
  }

  // ---------------------------------------------------------------------------
  // Operation dispatch
  // ---------------------------------------------------------------------------

  private async executeOperation(op: PendingOperation): Promise<void> {
    switch (op.type) {
      case "send_message":
        return this.syncSendMessage(op);
      case "send_file":
        return this.syncSendFile(op);
      case "edit_message":
        return this.syncEditMessage(op);
      case "delete_message":
        return this.syncDeleteMessage(op);
      case "send_reaction":
        return this.syncSendReaction(op);
      case "remove_reaction":
        return this.syncRemoveReaction(op);
      case "send_poll":
        return this.syncSendPoll(op);
      case "vote_poll":
        return this.syncVotePoll(op);
      case "send_transfer":
        return this.syncSendTransfer(op);
      default:
        console.warn("[SyncEngine] Unknown operation type:", op.type);
    }
  }

  // ---------------------------------------------------------------------------
  // Operation implementations
  // ---------------------------------------------------------------------------

  private async syncSendMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      content: string;
      replyToEventId?: string;
      forwardedFrom?: { senderId: string; senderName?: string };
      noPreview?: boolean;
    };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    let serverEventId: string;
    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(payload.content);

      // Add reply relation if present
      if (payload.replyToEventId) {
        (encrypted as Record<string, unknown>)["m.relates_to"] = {
          "m.in_reply_to": { event_id: payload.replyToEventId },
        };
      }
      // Add forward metadata
      if (payload.forwardedFrom) {
        (encrypted as Record<string, unknown>)["forwarded_from"] = {
          sender_id: payload.forwardedFrom.senderId,
          sender_name: payload.forwardedFrom.senderName,
        };
      }
      // Signal that sender explicitly dismissed the preview
      if (payload.noPreview) {
        (encrypted as Record<string, unknown>).no_preview = true;
      }

      serverEventId = await matrixService.sendEncryptedText(op.roomId, encrypted, op.clientId);
    } else {
      // Defense in depth: refuse to leak plaintext into a private room.
      // UI already blocks the compose via peerKeysOk, but a stale op in
      // the queue (e.g. background retry after peer lost keys) must not
      // silently downgrade. Public / "open channel" rooms fall through.
      if (roomCrypto?.requiresEncryption()) {
        throw new Error(`${ENCRYPTION_REQUIRED_NO_KEYS} — syncSendMessage`);
      }

      const content: Record<string, unknown> = {
        msgtype: "m.text",
        body: payload.content,
      };
      if (payload.replyToEventId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: payload.replyToEventId },
        };
      }
      if (payload.forwardedFrom) {
        content["forwarded_from"] = {
          sender_id: payload.forwardedFrom.senderId,
          sender_name: payload.forwardedFrom.senderName,
        };
      }
      if (payload.noPreview) {
        content.no_preview = true;
      }
      serverEventId = await matrixService.sendEncryptedText(op.roomId, content, op.clientId);
    }

    // Update local message: pending → synced
    await this.messageRepo.confirmSent(op.clientId, serverEventId);
    // Update room preview status so sidebar shows ✓ instead of pending
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
  }

  private async syncSendFile(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      fileName: string;
      mimeType: string;
      msgtype: string;
      attachmentId: number;
      /** Optional human-readable body. When omitted, syncSendFile writes
       *  the legacy JSON-encoded `{name,type,size}` body used by m.file
       *  messages. m.image / m.audio senders override this with the
       *  caption or a short tag string ("Image" / "Audio"). */
      body?: string;
      /** Optional pre-computed info object (image dimensions, audio duration,
       *  etc.). Merged into `content.info` with secrets appended. Keeps the
       *  per-type metadata intact without forcing syncSendFile to re-inspect
       *  the blob. */
      eventInfo?: Record<string, unknown>;
      /** Optional top-level event fields merged after msgtype — e.g.
       *  caption / captionAbove / bastyon-specific flags. */
      eventExtras?: Record<string, unknown>;
      /** Forward attribution for the receiving side. When present the
       *  outbound Matrix event gets a `forwarded_from` field so recipients
       *  render «Forwarded from <name>» on top of the media bubble. Mirrors
       *  syncSendMessage. */
      forwardedFrom?: { senderId: string; senderName?: string };
    };
    const matrixService = getMatrixClientService();

    // --- Acquire blob -------------------------------------------------------
    const attachment = await this.db.attachments.get(payload.attachmentId);
    if (!attachment?.localBlob) {
      throw new Error("Attachment blob not found");
    }

    // Register an AbortController for this upload so cancelMediaUpload(clientId)
    // can interrupt the in-flight fetch.
    const controller = new AbortController();
    this.activeUploads.set(op.clientId, controller);

    try {
      if (controller.signal.aborted) {
        throw new DOMException("Upload cancelled", "AbortError");
      }

      // --- Phase 1: encrypt (fast, fails loudly) ----------------------------
      const roomCrypto = await this.getRoomCrypto(op.roomId);
      let fileToUpload: Blob = attachment.localBlob;
      let secrets: Record<string, unknown> | undefined;

      if (roomCrypto?.canBeEncrypt()) {
        const encrypted = await withTimeout(
          roomCrypto.encryptFile(attachment.localBlob),
          MEDIA_ENCRYPT_TIMEOUT_MS,
          "Media encrypt",
        );
        fileToUpload = encrypted.file;
        secrets = encrypted.secrets;
      } else if (roomCrypto?.requiresEncryption()) {
        // Defense in depth: refuse to upload a plaintext attachment into a
        // private room. Same rationale as syncSendMessage.
        throw new Error(`${ENCRYPTION_REQUIRED_NO_KEYS} — syncSendFile upload`);
      }

      await this.db.attachments.update(attachment.id!, {
        status: "uploading",
        encryptionSecrets: secrets,
      });

      // --- Phase 2: upload (longest — big files on slow links) --------------
      if (controller.signal.aborted) {
        throw new DOMException("Upload cancelled", "AbortError");
      }
      const onProgress = makeThrottledProgress((percent) => {
        // fire-and-forget; progress is advisory and must not stall upload
        void this.messageRepo.updateUploadProgress(op.clientId, percent);
      });
      // The retry loop sits *inside* the timeout so the deadline covers the
      // whole upload phase (including in-attempt retries) rather than being
      // reset between attempts — protects against a runaway 4×4-min loop on
      // a flaky link.
      const url = await withTimeout(
        uploadWithRetry(
          () =>
            matrixService.uploadContent(
              fileToUpload,
              onProgress,
              controller.signal,
            ),
          controller.signal,
        ),
        MEDIA_UPLOAD_TIMEOUT_MS,
        "Media upload",
      );

      await this.db.attachments.update(attachment.id!, {
        status: "uploaded",
        remoteUrl: url,
      });

      // --- Phase 3: send event (short, just a Matrix PUT) --------------------
      if (controller.signal.aborted) {
        throw new DOMException("Upload cancelled", "AbortError");
      }

      // Prefer structured fileInfo body (matches sendFile's JSON shape) so
      // existing viewers keep rendering. Callers that need richer metadata
      // (m.image with dimensions, m.audio with duration) pass eventInfo /
      // eventExtras which merge on top.
      // m.file with no explicit body: embed url + secrets inside the JSON
      // body so any client (old bastyon-chat parsers, recipients running
      // matrix-client.ts that JSON.parses body into pbody) can recover the
      // mxc URL even when they ignore top-level content.url. Without this
      // forwarded/uploaded PDFs throw MissingUrlError on the sender after
      // /sync re-parses the event (WEE-28).
      const defaultFileBody: Record<string, unknown> = {
        name: payload.fileName,
        type: payload.mimeType,
        size: attachment.size,
      };
      if (payload.msgtype === "m.file") {
        defaultFileBody.url = url;
        if (secrets) defaultFileBody.secrets = secrets;
      }
      const content: Record<string, unknown> = {
        msgtype: payload.msgtype,
        body: payload.body ?? JSON.stringify(defaultFileBody),
        url,
        ...(payload.eventExtras ?? {}),
      };
      if (payload.eventInfo) {
        content.info = {
          ...payload.eventInfo,
          ...(secrets ? { secrets } : {}),
        };
      } else if (secrets) {
        content.secrets = secrets;
      }
      if (payload.forwardedFrom) {
        content.forwarded_from = {
          sender_id: payload.forwardedFrom.senderId,
          sender_name: payload.forwardedFrom.senderName,
        };
      }

      const serverEventId = await withTimeout(
        matrixService.sendEncryptedText(op.roomId, content, op.clientId),
        MEDIA_SEND_EVENT_TIMEOUT_MS,
        "Media send event",
      );

      // Persist the mxc URL on the local message. Without this the bubble
      // keeps a blob: URL that becomes invalid the moment the document is
      // unloaded — closing the chat or reloading the app paints a broken
      // image (issues #655, #629, #636). confirmMediaSent also clears
      // localBlobUrl and updates the room preview status atomically.
      const existing = await this.messageRepo.getByClientId(op.clientId);
      const baseFileInfo: LocalMessage["fileInfo"] = existing?.fileInfo ?? {
        name: payload.fileName,
        type: payload.mimeType,
        size: attachment.size,
        url,
      };
      const serverFileInfo: LocalMessage["fileInfo"] = {
        ...baseFileInfo,
        url,
        ...(secrets
          ? { secrets: secrets as { block: number; keys: string; v: number } }
          : {}),
      };
      await this.messageRepo.confirmMediaSent(
        op.clientId,
        serverEventId,
        serverFileInfo,
        op.roomId,
      );

      // Release the optimistic blob URL after a short grace window so any
      // in-flight render with that source can complete before the browser
      // invalidates it. Without this revoke the blob lingers in memory for
      // the lifetime of the document and slowly leaks as users send more
      // photos in the same session.
      const optimisticBlob = existing?.localBlobUrl;
      if (
        optimisticBlob &&
        typeof URL !== "undefined" &&
        typeof URL.revokeObjectURL === "function"
      ) {
        setTimeout(() => {
          try {
            URL.revokeObjectURL(optimisticBlob);
          } catch {
            // Some test envs (e.g. happy-dom without object URLs) throw —
            // best-effort cleanup, ignore.
          }
        }, 5_000);
      }
    } finally {
      // Release the controller slot regardless of outcome so a retry can
      // register a fresh one.
      const current = this.activeUploads.get(op.clientId);
      if (current === controller) this.activeUploads.delete(op.clientId);
    }
  }

  private async syncEditMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; newContent: string };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    let body: string | Record<string, unknown> = payload.newContent;
    const content: Record<string, unknown> = {
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: payload.eventId,
      },
    };

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(payload.newContent);
      content.msgtype = "m.encrypted";
      content.body = (encrypted as Record<string, unknown>).body;
      content.block = (encrypted as Record<string, unknown>).block;
      content.version = (encrypted as Record<string, unknown>).version;
      content["m.new_content"] = encrypted;
    } else {
      // Defense in depth: a plaintext edit would replace a ciphertext
      // bubble with the original text (server-visible), leaking the
      // message even if the original send was encrypted.
      if (roomCrypto?.requiresEncryption()) {
        throw new Error(`${ENCRYPTION_REQUIRED_NO_KEYS} — syncEditMessage`);
      }
      content.msgtype = "m.text";
      content.body = `* ${payload.newContent}`;
      content["m.new_content"] = {
        msgtype: "m.text",
        body: payload.newContent,
      };
    }

    // Idempotent edit: use clientId as txnId so an edit is never applied twice
    // if the user has multiple tabs or a flaky connection causes a retry.
    await matrixService.sendEncryptedText(op.roomId, content, op.clientId);
  }

  private async syncDeleteMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string };
    const matrixService = getMatrixClientService();
    await matrixService.redactEvent(op.roomId, payload.eventId);
  }

  private async syncSendReaction(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; emoji: string };
    const matrixService = getMatrixClientService();
    const reactionEventId = await matrixService.sendReaction(
      op.roomId,
      payload.eventId,
      payload.emoji,
    );

    // Store the reaction eventId so we can remove it later
    const msg = await this.messageRepo.getByEventId(payload.eventId);
    if (msg?.reactions?.[payload.emoji]) {
      msg.reactions[payload.emoji].myEventId = reactionEventId;
      await this.messageRepo.updateReactions(payload.eventId, msg.reactions);
    }
  }

  private async syncRemoveReaction(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; reactionEventId: string };
    const matrixService = getMatrixClientService();
    await matrixService.redactEvent(op.roomId, payload.reactionEventId);
  }

  private async syncSendPoll(op: PendingOperation): Promise<void> {
    const payload = op.payload as { question: string; options: string[] };
    const matrixService = getMatrixClientService();

    const answers = payload.options.map((text, i) => ({
      id: `option_${i}`,
      "org.matrix.msc1767.text": text,
      body: text,
    }));

    await matrixService.sendPollStart(op.roomId, {
      "org.matrix.msc3381.poll.start": {
        kind: "org.matrix.msc3381.poll.disclosed",
        question: { body: payload.question, "org.matrix.msc1767.text": payload.question },
        answers,
        max_selections: 1,
      },
    });

    const pollEventId = `poll_${Date.now()}`;
    await this.messageRepo.confirmSent(op.clientId, pollEventId);
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: pollEventId,
    });
  }

  private async syncVotePoll(op: PendingOperation): Promise<void> {
    const payload = op.payload as { pollEventId: string; optionId: string };
    const matrixService = getMatrixClientService();

    await matrixService.sendPollResponse(op.roomId, {
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: payload.pollEventId,
      },
      "org.matrix.msc3381.poll.response": {
        answers: [payload.optionId],
      },
    });
  }

  private async syncSendTransfer(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      txId: string;
      amount: number;
      from: string;
      to: string;
      message?: string;
    };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    // Encode transfer as JSON body (same format as use-messages.ts)
    const transferBody = JSON.stringify({
      _transfer: true,
      txId: payload.txId,
      amount: payload.amount,
      from: payload.from,
      to: payload.to,
      message: payload.message,
    });

    // Transfers MUST dedupe on retry — a double-send here would mean a
    // duplicate tip bubble for the recipient. Pass clientId as the Matrix
    // txnId on both the encrypted and plaintext paths.
    let serverEventId: string;
    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(transferBody);
      serverEventId = await matrixService.sendEncryptedText(op.roomId, encrypted, op.clientId);
    } else {
      // Defense in depth: transfer bodies carry a txId + recipient address
      // and must never land in the clear inside a private room.
      if (roomCrypto?.requiresEncryption()) {
        throw new Error(`${ENCRYPTION_REQUIRED_NO_KEYS} — syncSendTransfer`);
      }
      serverEventId = await matrixService.sendText(op.roomId, transferBody, op.clientId);
    }

    await this.messageRepo.confirmSent(op.clientId, serverEventId);
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Mark the message associated with a failed operation.
   *  No-op when the message has already been confirmed (eventId present or
   *  status already "synced") — the matrix-js-sdk error happened after the
   *  server actually accepted the event and the /sync echo restored state.
   *  Without this guard the watchdog/retry-exhaustion path would flip a
   *  successfully delivered message back to "failed" and surface a false
   *  retry indicator (WEE-40). */
  private async markMessageFailed(op: PendingOperation): Promise<void> {
    if (!op.clientId) return;
    if (await this.isMessageAlreadyConfirmed(op.clientId)) return;
    await this.messageRepo.updateStatus(
      { clientId: op.clientId },
      "failed",
    );

    // WEE-64: mirror the success-path room write (:607-610) so the chat-list
    // preview shows the same failed badge the open chat does. Guarded twice:
    //   (a) only outbound send-ops — an edit/reaction/delete failure must not
    //       corrupt the preview badge of an unrelated last message;
    //   (b) only when this message is still the room's last message
    //       (RoomRepository.syncLastMessageLocalStatus enforces the timestamp
    //       check) — a newer message already advanced the preview.
    if (SEND_OPS.has(op.type)) {
      const failedMsg = await this.messageRepo.getByClientId(op.clientId);
      if (failedMsg) {
        await this.roomRepo.syncLastMessageLocalStatus(
          op.roomId,
          failedMsg.timestamp,
          "failed",
        );
      }
    }
  }

  /** Returns true when the local message row for `clientId` already has a
   *  server eventId or has been flipped to "synced" — typically by an
   *  upsertFromServer echo that won the race against the queue's failure
   *  handler. Used to suppress false-failed transitions in markMessageFailed
   *  and processTick. */
  private async isMessageAlreadyConfirmed(clientId: string): Promise<boolean> {
    const msg = await this.messageRepo.getByClientId(clientId);
    if (!msg) return false;
    return Boolean(msg.eventId) || msg.status === "synced";
  }

  /** Whether the Matrix client is ready to transport ops. Gates ONLY on an
   *  explicit `isReady() === false`; anything else (true, or a test double that
   *  omits `isReady` / returns undefined) is treated as ready, so the gate is a
   *  no-op under harnesses that don't model readiness. The real service always
   *  returns a boolean, so prod behaviour is exactly `isReady() === true`. */
  private isMatrixReady(): boolean {
    const svc = getMatrixClientService() as { isReady?: () => boolean };
    return svc.isReady?.() !== false;
  }

  /** Enqueue a new operation. Returns the operation ID. */
  async enqueue(
    type: PendingOperation["type"],
    roomId: string,
    payload: Record<string, unknown>,
    clientId?: string,
    maxRetries = 5,
  ): Promise<number> {
    const id = await this.db.pendingOps.add({
      type,
      roomId,
      payload,
      status: "pending",
      retries: 0,
      maxRetries,
      createdAt: Date.now(),
      clientId: clientId ?? crypto.randomUUID(),
      nextAttemptAt: 0, // due immediately
    });

    // Kick off processing (non-blocking)
    this.processQueue();
    return id as number;
  }

  /** Retry a specific failed operation */
  async retryOperation(opId: number): Promise<void> {
    await this.db.pendingOps.update(opId, {
      status: "pending",
      retries: 0,
      errorMessage: undefined,
      nextAttemptAt: 0,
    });
    // Also reset the associated message status
    const op = await this.db.pendingOps.get(opId);
    if (op?.clientId) {
      await this.messageRepo.updateStatus({ clientId: op.clientId }, "pending");
    }
    this.processQueue();
  }

  /** Retry all failed operations */
  async retryAllFailed(): Promise<void> {
    // Snapshot the failed ops BEFORE resetting them so we can mirror the
    // reset onto each room's preview status (WEE-64).
    const failedOps = await this.db.pendingOps.where("status").equals("failed").toArray();
    await this.db.pendingOps
      .where("status")
      .equals("failed")
      .modify({ status: "pending", retries: 0, errorMessage: undefined, nextAttemptAt: 0 });

    // WEE-64: a failed send returning to the queue must reset its chat-list
    // preview from "failed" back to "pending" (отправляется), symmetric to
    // markMessageFailed — otherwise the sidebar shows a stale error while the
    // retry is in flight. Same send-op + still-last-message guards apply.
    for (const op of failedOps) {
      if (!op.clientId || !SEND_OPS.has(op.type)) continue;
      const msg = await this.messageRepo.getByClientId(op.clientId);
      if (msg) {
        await this.roomRepo.syncLastMessageLocalStatus(op.roomId, msg.timestamp, "pending");
      }
    }

    this.processQueue();
  }

  /** Get count of pending/failed operations */
  async getQueueStatus(): Promise<{ pending: number; failed: number }> {
    const pending = await this.db.pendingOps.where("status").equals("pending").count();
    const failed = await this.db.pendingOps.where("status").equals("failed").count();
    return { pending, failed };
  }

  /**
   * Cancel an in-flight media upload by clientId. Aborts the signal so the
   * Matrix SDK tears down the XHR, then removes the pending op so the
   * scheduler does not resume it after restart. The message row itself
   * stays untouched — the caller (use-messages cancelMediaUpload) owns
   * flipping status to "cancelled" / revoking the preview blob URL.
   */
  async cancelMediaUpload(clientId: string): Promise<void> {
    this.activeUploads.get(clientId)?.abort();
    this.activeUploads.delete(clientId);
    // Narrow the delete to send_file ops. clientId is not unique across
    // op types (a send_message op could share it), so a broad delete
    // could clobber unrelated queued sends.
    await this.db.pendingOps
      .where("clientId")
      .equals(clientId)
      .filter((op) => op.type === "send_file")
      .delete();
  }

  /** Cancel a pending/failed operation and clean up */
  async cancelOperation(opId: number): Promise<void> {
    const op = await this.db.pendingOps.get(opId);
    if (!op) return;

    // Remove the pending message if it was a send
    if (op.type === "send_message" || op.type === "send_file" || op.type === "send_transfer") {
      const msg = await this.messageRepo.getByClientId(op.clientId);
      if (msg?.localId && !msg.eventId) {
        await this.db.messages.delete(msg.localId);
      }
    }

    await this.db.pendingOps.delete(opId);
    this.onChange?.(op.roomId);
  }
}
