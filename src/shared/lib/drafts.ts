const DRAFT_PREFIX = "bastyon-chat:draft:";
const LEGACY_KEY = "bastyon-chat:drafts";

// One-time migration from legacy single-key format to per-room keys
let migrated = false;

/** @internal Reset migration flag — for tests only */
export function _resetMigration() { migrated = false; }

function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const drafts: Record<string, string> = JSON.parse(raw);
    for (const [roomId, text] of Object.entries(drafts)) {
      if (text?.trim()) localStorage.setItem(DRAFT_PREFIX + roomId, text);
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore corrupt legacy data
  }
}

export function getDraft(roomId: string): string {
  migrateLegacy();
  return localStorage.getItem(DRAFT_PREFIX + roomId) ?? "";
}

export function saveDraft(roomId: string, text: string) {
  migrateLegacy();
  if (text.trim()) {
    localStorage.setItem(DRAFT_PREFIX + roomId, text);
  } else {
    localStorage.removeItem(DRAFT_PREFIX + roomId);
  }
}

export function clearDraft(roomId: string) {
  localStorage.removeItem(DRAFT_PREFIX + roomId);
}
