import { useLocalAiStore } from "../model/local-ai-store";

export interface AiDiagnostics {
  /** Pre-formatted, ready to paste into a bug-report issue body. */
  logs: string;
}

const EXPORT_LIMIT = 200;

/**
 * Pulls `local-ai`'s persisted log store for the bug-report envelope
 * (plan §11, roadmap 7.6) — the only diagnostic channel available for a
 * Capacitor integration that has never run on a real device in the
 * library's own test suite (plan §1, §10). Mirrors
 * `collect-call-diagnostics.ts`'s contract: always non-throwing, resolves
 * `undefined` when there's nothing to attach so the caller can skip the
 * section entirely rather than show an empty one.
 *
 * No "opened from AI context" flag needed — if `useLocalAiStore().client`
 * is null, the feature was never touched this session and there is nothing
 * to export; every other bug report already collects this unconditionally
 * (cheap local SQLite read), same as `collectCallDiagnostics()`.
 */
export async function collectAiDiagnostics(): Promise<AiDiagnostics | undefined> {
  const store = useLocalAiStore();
  if (!store.client) return undefined;

  try {
    const entries = await store.client.exportLogs({ limit: EXPORT_LIMIT });
    if (entries.length === 0) return undefined;

    const logs = entries
      .map((e) => `[${e.ts}] ${e.level.toUpperCase()} ${e.message}${e.meta ? ` ${JSON.stringify(e.meta)}` : ""}`)
      .join("\n");
    return { logs };
  } catch {
    return undefined;
  }
}
