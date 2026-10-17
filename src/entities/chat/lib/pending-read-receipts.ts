/**
 * Read receipts the server has not acknowledged, kept across app restarts.
 *
 * Samsung 2026-10-14: a chat read with no network queued its receipt in
 * memory only. A swipe before the network came back lost it, and after the
 * restart the server's old count brought the chat back as unread (and the
 * next message showed "3 unread" for one).
 */

/** One room's receipt: the read position (`ts`) and when it was queued (`at`). */
export interface PendingReceipt {
  ts: number;
  at: number;
}

/** A receipt this old is dropped: its room may be gone, and the read is stale. */
export const PENDING_RECEIPT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const pendingReceiptsKey = (address: string): string => `chat_pending_read_receipts:${address}`;

const isPositiveNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Receipts from storage, without malformed entries and those past the age limit. */
export function parsePendingReceipts(raw: string | null, now: number): Map<string, PendingReceipt> {
  const out = new Map<string, PendingReceipt>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [roomId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { ts, at } = value as { ts?: unknown; at?: unknown };
    if (!isPositiveNumber(ts) || !isPositiveNumber(at)) continue;
    if (now - at > PENDING_RECEIPT_MAX_AGE_MS) continue;
    out.set(roomId, { ts, at });
  }
  return out;
}

export function serializePendingReceipts(receipts: ReadonlyMap<string, PendingReceipt>): string {
  return JSON.stringify(Object.fromEntries(receipts));
}
