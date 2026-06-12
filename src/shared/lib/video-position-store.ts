/**
 * Persistent per-video playback positions (WEE-82 / forta-bugs#964).
 *
 * Cross-origin iframes can't expose currentTime, so position memory only
 * works for natively-played videos. Keyed by video URL; survives modal
 * close/reopen and app cold restarts via localStorage (bounded LRU).
 */

const STORAGE_KEY = "forta-video-positions";
const MAX_ENTRIES = 50;

/** Don't bother saving positions in the first seconds — restarting is fine. */
const MIN_SAVE_POSITION_S = 5;
/** Treat positions this close to the end as "watched" — restart next time. */
const END_GRACE_S = 5;

interface PositionEntry {
  /** Position in seconds */
  pos: number;
  /** Last-update timestamp for LRU eviction */
  at: number;
}

type PositionMap = Record<string, PositionEntry>;

// In-memory cache: localStorage is read once and written through on flush.
let cache: PositionMap | null = null;

function load(): PositionMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as PositionMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(map: PositionMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — position memory degrades gracefully */
  }
}

function evictOldest(map: PositionMap): void {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => map[a].at - map[b].at)
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((k) => delete map[k]);
}

/** Saved position for the video, or 0 when none / too close to start or end. */
export function getVideoPosition(key: string): number {
  const entry = load()[key];
  return entry?.pos ?? 0;
}

/**
 * Save the playback position. Positions near the start are dropped and
 * positions near the end clear the entry (rewatch starts from 0).
 */
export function saveVideoPosition(key: string, positionS: number, durationS: number): void {
  if (!key) return;
  const map = load();

  const nearStart = positionS < MIN_SAVE_POSITION_S;
  const nearEnd = durationS > 0 && positionS > durationS - END_GRACE_S;
  if (nearStart || nearEnd) {
    if (map[key]) {
      delete map[key];
      persist(map);
    }
    return;
  }

  map[key] = { pos: positionS, at: Date.now() };
  evictOldest(map);
  persist(map);
}

/** Remove the saved position (e.g. video finished). */
export function clearVideoPosition(key: string): void {
  const map = load();
  if (!map[key]) return;
  delete map[key];
  persist(map);
}

/** Test-only: drop the in-memory cache so localStorage is re-read. */
export function _resetVideoPositionCache(): void {
  cache = null;
}
