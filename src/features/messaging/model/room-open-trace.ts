import { getPerfCounts, perfMark } from "@/shared/lib/perf-markers";

/** Counters worth reporting per room open: Dexie write transactions started
 *  by the open-time loaders, network scrollback and single-event requests. */
const TRACED_COUNTERS = ["dexie:rw:open", "net:scrollback", "net:event"] as const;

/** localStorage switch for the one-line summary in production builds
 *  (`localStorage.setItem("forta-chat:perf", "1")` in chrome://inspect). */
const PERF_FLAG_KEY = "forta-chat:perf";
/** Background work (refresh, prefetch) runs after the reveal; a second line
 *  reports the counters this long after settling. */
export const ROOM_OPEN_TAIL_MS = 5_000;

const isTraceLogEnabled = (): boolean => {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem(PERF_FLAG_KEY) === "1";
  } catch {
    return false;
  }
};

export interface RoomOpenTrace {
  /** Record a step (`peek`, `first-emission`, `branch`, ...) with an optional detail. */
  mark: (step: string, detail?: string | number) => void;
  /** Close the trace: `room-open:settled` mark + one summary line (DEV or flag
   *  only), then a `tail+5s` line with the counters after background work. */
  settle: () => void;
}

/**
 * Timing of one room open for the chat-open investigation (plan
 * 2026-09-28-chat-open-local-first, stage 0). Emits `performance` marks
 * `room-open:<step>` for the Performance panel and a single
 * `[room-open] …` console line with the step offsets and how many Dexie
 * writes / scrollbacks ran between the open and the reveal.
 */
export function createRoomOpenTrace(roomId: string): RoomOpenTrace {
  const startedAt = performance.now();
  const countsAtStart = new Map(TRACED_COUNTERS.map((c) => [c, getPerfCounts().get(c) ?? 0]));
  const steps: string[] = [];
  let settled = false;

  perfMark("room-open:start");

  const mark = (step: string, detail?: string | number): void => {
    if (settled) return;
    perfMark(`room-open:${step}`);
    const offset = Math.round(performance.now() - startedAt);
    steps.push(detail === undefined ? `${step}@${offset}` : `${step}=${detail}@${offset}`);
  };

  const settle = (): void => {
    if (settled) return;
    mark("settled");
    settled = true;
    if (!isTraceLogEnabled()) return;
    const counts = (): string => TRACED_COUNTERS.map(
      (c) => `${c}=${(getPerfCounts().get(c) ?? 0) - (countsAtStart.get(c) ?? 0)}`,
    ).join(" ");
    const room = roomId.slice(0, 12);
    console.info(`[room-open] ${room} ${steps.join(" ")} ${counts()}`);
    setTimeout(() => {
      console.info(`[room-open] ${room} tail+${ROOM_OPEN_TAIL_MS / 1000}s ${counts()}`);
    }, ROOM_OPEN_TAIL_MS);
  };

  return { mark, settle };
}
