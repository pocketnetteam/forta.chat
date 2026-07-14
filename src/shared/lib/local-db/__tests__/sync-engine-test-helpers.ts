import type Dexie from "dexie";
import type { SyncEngine } from "../sync-engine";

/** Drain micro/macrotask queues so in-flight SyncEngine bookkeeping settles. */
export function waitTicks(n = 5): Promise<void> {
  return new Promise((resolve) => {
    let remaining = n;
    function next() {
      if (remaining-- <= 0) resolve();
      else setTimeout(next, 0);
    }
    next();
  });
}

/** Stop the engine, drain async work, then tear down the test Dexie DB safely. */
export async function disposeSyncEngineHarness(h: {
  engine: SyncEngine;
  db: Dexie;
}): Promise<void> {
  h.engine.dispose();
  await waitTicks(5);
  try {
    await h.db.close();
  } catch {
    // already closed
  }
  await h.db.delete();
}
