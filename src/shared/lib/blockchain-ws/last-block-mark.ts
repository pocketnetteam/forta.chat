/**
 * Last block the blockchain WS delivered, persisted per account with the time
 * it arrived. `getmissedinfo` needs a real block to resume from: without one
 * (the socket never connected on this device) there is nothing to catch up.
 *
 * Blocks come about once a minute, so elapsed minutes since the mark estimate
 * how many blocks were missed — no extra getnodeinfo needed to cap the range.
 */

/** Pocketnet block interval used to estimate the current height. */
export const BLOCK_INTERVAL_MS = 60_000;

/** getmissedinfo never reaches further back than this many blocks. */
export const MAX_CATCHUP_BLOCKS = 2_000;

/** Fewer missed blocks than this are not worth a catch-up (matches the legacy
 *  2-minute guard; the live socket fills shorter gaps). */
export const MIN_MISSED_BLOCKS = 2;

export interface BlockMark {
  height: number;
  /** ms timestamp when the block arrived over the socket. */
  at: number;
}

const KEY_PREFIX = "blockchain_ws_block";

export function readBlockMark(address: string): BlockMark | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}:${address}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<BlockMark> | null;
    if (!p || typeof p.height !== "number" || p.height <= 0 || typeof p.at !== "number") return null;
    return { height: p.height, at: p.at };
  } catch {
    return null;
  }
}

export function writeBlockMark(address: string, height: number, now = Date.now()): void {
  if (!address || !(height > 0)) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}:${address}`, JSON.stringify({ height, at: now }));
  } catch {
    /* storage blocked — catch-up just won't run next time */
  }
}

/** Block to pass to getmissedinfo, or null when there is nothing to do: no
 *  mark yet, or the gap is shorter than {@link MIN_MISSED_BLOCKS}. A gap longer
 *  than {@link MAX_CATCHUP_BLOCKS} starts that many blocks before the
 *  estimated current height. */
export function catchUpFromBlock(mark: BlockMark | null, now = Date.now()): number | null {
  if (!mark) return null;
  const missed = Math.floor((now - mark.at) / BLOCK_INTERVAL_MS);
  if (missed < MIN_MISSED_BLOCKS) return null;
  return Math.max(mark.height, mark.height + missed - MAX_CATCHUP_BLOCKS);
}
