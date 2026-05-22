import { ref, computed, watch, type Ref } from "vue";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import { hexEncode, hexDecode } from "@/shared/lib/matrix/functions";

/**
 * Tracked mention inserted via autocomplete.
 * The textarea shows `@DisplaySafeName` (display, may include the user's
 * private local alias for readability), but on send we expand it to
 * `@hexId:CanonicalSafeName` (raw mention format using the canonical name
 * peers know — see WEE-39 follow-up: prior code embedded the local alias in
 * the wire payload, so recipients saw a stranger string instead of the
 * sender they recognize).
 */
interface MentionToken {
  start: number;        // index of '@' in display text
  end: number;          // index after display name (before trailing space)
  hexId: string;
  /** Sanitised canonical name (no local alias). Used in the wire payload. */
  safeName: string;
  display: string;      // "@DisplaySafeName" as it appears in the textarea
}

/**
 * Composable for Telegram-style @mention autocomplete in group chats.
 *
 * Shows `@DisplayName` in the textarea (human-friendly), tracks positions,
 * and expands to `@hexId:DisplayName` on send via `resolveText()`.
 */
export function useMentionAutocomplete(
  text: Ref<string>,
  textareaRef: Ref<HTMLTextAreaElement | undefined>,
) {
  const chatStore = useChatStore();
  const authStore = useAuthStore();

  const active = ref(false);
  const query = ref("");
  const triggerIndex = ref(0);
  const selectedIndex = ref(0);

  // Position-tracked mentions
  const mentions = ref<MentionToken[]>([]);
  let lastText = "";

  /**
   * Sync mention token positions after a text edit.
   * Uses a prefix/suffix diff to find the edit region, then shifts
   * or invalidates tokens accordingly.
   */
  const syncMentions = () => {
    const newText = text.value;
    if (newText === lastText) return;

    const oldText = lastText;
    lastText = newText;

    if (mentions.value.length === 0) return;

    // Find common prefix
    let pre = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (pre < minLen && oldText[pre] === newText[pre]) pre++;

    // Find common suffix (not overlapping with prefix)
    let suf = 0;
    while (
      suf < minLen - pre &&
      oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]
    ) suf++;

    const oldEditEnd = oldText.length - suf;
    const delta = newText.length - oldText.length;

    const surviving: MentionToken[] = [];
    for (const m of mentions.value) {
      if (m.end <= pre) {
        // Entirely before the edit — unchanged
        surviving.push(m);
      } else if (m.start >= oldEditEnd) {
        // Entirely after the edit — shift by delta
        surviving.push({ ...m, start: m.start + delta, end: m.end + delta });
      }
      // Overlaps with the edit — drop (user edited within the mention)
    }
    mentions.value = surviving;
  };

  /** Scan backwards from cursor to detect `@` trigger. */
  const onCursorChange = () => {
    syncMentions();

    const el = textareaRef.value;
    if (!el) { active.value = false; return; }

    const cursor = el.selectionStart ?? 0;
    const val = text.value;

    // Scan backwards from cursor to find `@`
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === "@") {
        // `@` must be at start of text or preceded by whitespace
        if (i > 0 && !/\s/.test(val[i - 1])) {
          active.value = false;
          return;
        }
        const q = val.slice(i + 1, cursor);
        // Query must not contain spaces (user is still typing the name)
        if (/\s/.test(q)) {
          active.value = false;
          return;
        }
        const wasActive = active.value;
        const prevQuery = query.value;
        active.value = true;
        query.value = q;
        triggerIndex.value = i;
        // Сбрасываем выбор только при открытии списка или при изменении запроса (набор символов).
        // Иначе при keyup после ArrowUp/ArrowDown выбор сбрасывался обратно на первый пункт.
        if (!wasActive || prevQuery !== q) selectedIndex.value = 0;
        return;
      }
      // Stop scanning at whitespace (no `@` found before a word boundary)
      if (/\s/.test(ch)) break;
    }

    active.value = false;
  };

  // When autocomplete activates, batch-load profiles for members missing from user store.
  // This ensures display names are available for filtering and display.
  let lastLoadedRoomId = "";
  watch(active, (isActive) => {
    if (!isActive) return;
    const room = chatStore.activeRoom;
    if (!room?.isGroup || room.id === lastLoadedRoomId) return;
    lastLoadedRoomId = room.id;
    const uStore = useUserStore();
    const selfHex = authStore.address ? hexEncode(authStore.address).toLowerCase() : "";
    const toLoad: string[] = [];
    for (const hexId of room.members) {
      if (hexId.toLowerCase() === selfHex) continue;
      const addr = hexDecode(hexId);
      if (addr !== hexId && /^[A-Za-z0-9]+$/.test(addr) && !uStore.users[addr]) {
        toLoad.push(addr);
      }
    }
    if (toLoad.length > 0) uStore.loadUsersBatch(toLoad);
  });

  /** Filtered member hex IDs (excluding self). */
  const filteredMembers = computed(() => {
    if (!active.value) return [];
    const room = chatStore.activeRoom;
    if (!room?.isGroup) return [];

    const selfHex = authStore.address ? hexEncode(authStore.address).toLowerCase() : "";
    const q = query.value.toLowerCase();
    // Touch user store to make this computed reactive to profile loads
    const allUsers = useUserStore().users;

    return room.members
      .filter((hexId) => {
        if (hexId.toLowerCase() === selfHex) return false;
        if (!q) return true;
        // Check display name from chat store (Matrix SDK + user store)
        const displayName = chatStore.getDisplayName(hexId);
        if (displayName.toLowerCase().includes(q)) return true;
        // Also check Bastyon address directly (user might type address)
        const addr = hexDecode(hexId);
        if (addr.toLowerCase().includes(q)) return true;
        // Check user store name directly (reactive — updates when profiles load)
        const user = allUsers[addr];
        if (user?.name?.toLowerCase().includes(q)) return true;
        return false;
      })
      .slice(0, 50);
  });

  // Держим selectedIndex в границах списка (напр. после загрузки профилей список пересчитывается)
  watch(filteredMembers, (list) => {
    const len = list.length;
    if (len > 0 && selectedIndex.value >= len) selectedIndex.value = len - 1;
  }, { immediate: true });

  /** Insert a mention at the trigger position (display-only in textarea).
   *
   *  Two names are computed:
   *  - `displaySafe` (textarea / pill) uses the user-facing display name —
   *    if they renamed the contact locally ("qqq"), the input shows `@qqq`
   *    so the sender keeps a familiar reference.
   *  - `safeName` (wire payload) uses the CANONICAL display name — what
   *    peers actually know the user as ("dqwewr"). The local alias must
   *    never travel through `@hexId:safeName` because recipients do not
   *    share the sender's address book and would parse it as a stranger
   *    string. (WEE-39 follow-up.)
   */
  const insertMention = (hexId: string) => {
    const el = textareaRef.value;
    if (!el) return;

    const sanitise = (raw: string): string =>
      raw.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 50) || hexId.slice(0, 8);

    const canonicalName = chatStore.getCanonicalDisplayName(hexId);
    const safeName = sanitise(canonicalName);

    const displayName = chatStore.getDisplayName(hexId);
    const displaySafe = sanitise(displayName);

    const displayMention = `@${displaySafe}`;
    const insertion = displayMention + " "; // trailing space

    const before = text.value.slice(0, triggerIndex.value);
    const cursor = el.selectionStart ?? text.value.length;
    const after = text.value.slice(cursor);

    // Shift existing mentions that come after the insertion point
    const replacedLen = cursor - triggerIndex.value;
    const delta = insertion.length - replacedLen;
    for (let i = 0; i < mentions.value.length; i++) {
      const m = mentions.value[i];
      if (m.start >= triggerIndex.value) {
        mentions.value[i] = { ...m, start: m.start + delta, end: m.end + delta };
      }
    }

    // Add new mention token
    mentions.value.push({
      start: triggerIndex.value,
      end: triggerIndex.value + displayMention.length,
      hexId,
      safeName,
      display: displayMention,
    });

    // Update text and lastText together (prevent syncMentions from misinterpreting)
    text.value = before + insertion + after;
    lastText = text.value;

    const newCursor = before.length + insertion.length;
    queueMicrotask(() => {
      el.selectionStart = el.selectionEnd = newCursor;
      el.focus();
    });

    active.value = false;
  };

  /**
   * Convert display text to raw format for sending.
   * Expands tracked `@SafeName` → `@hexId:SafeName`.
   */
  const resolveText = (): string => {
    if (mentions.value.length === 0) return text.value;

    const sorted = [...mentions.value].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;

    for (const m of sorted) {
      // Verify the mention is still intact at the expected position
      const actual = text.value.slice(m.start, m.end);
      if (actual !== m.display) continue;

      result += text.value.slice(cursor, m.start);
      result += `@${m.hexId}:${m.safeName}`;
      cursor = m.end;
    }
    result += text.value.slice(cursor);
    return result;
  };

  /** Clear tracked mentions (call after sending or switching rooms). */
  const clearMentions = () => {
    mentions.value = [];
    lastText = text.value;
    lastLoadedRoomId = ""; // allow re-loading members for new room
  };

  /**
   * Keyboard handler — returns `true` if the key was consumed.
   * Caller should skip its own handling when true.
   */
  const handleKeydown = (e: KeyboardEvent): boolean => {
    if (!active.value || filteredMembers.value.length === 0) return false;

    const len = filteredMembers.value.length;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex.value = (selectedIndex.value + 1) % len;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex.value = (selectedIndex.value - 1 + len) % len;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertMention(filteredMembers.value[selectedIndex.value]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      active.value = false;
      return true;
    }

    return false;
  };

  return {
    active,
    query,
    filteredMembers,
    selectedIndex,
    insertMention,
    handleKeydown,
    onCursorChange,
    resolveText,
    clearMentions,
  };
}
