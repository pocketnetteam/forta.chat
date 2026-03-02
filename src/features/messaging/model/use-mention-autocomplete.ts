import { ref, computed, type Ref } from "vue";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { hexEncode } from "@/shared/lib/matrix/functions";

/**
 * Tracked mention inserted via autocomplete.
 * The textarea shows `@SafeName` (display), but on send
 * we expand it to `@hexId:SafeName` (raw mention format).
 */
interface MentionToken {
  start: number;   // index of '@' in display text
  end: number;     // index after display name (before trailing space)
  hexId: string;
  safeName: string;
  display: string; // "@SafeName" as it appears in the textarea
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
        active.value = true;
        query.value = q;
        triggerIndex.value = i;
        selectedIndex.value = 0;
        return;
      }
      // Stop scanning at whitespace (no `@` found before a word boundary)
      if (/\s/.test(ch)) break;
    }

    active.value = false;
  };

  /** Filtered member hex IDs (excluding self). */
  const filteredMembers = computed(() => {
    if (!active.value) return [];
    const room = chatStore.activeRoom;
    if (!room?.isGroup) return [];

    const selfHex = authStore.address ? hexEncode(authStore.address).toLowerCase() : "";
    const q = query.value.toLowerCase();

    return room.members
      .filter((hexId) => {
        if (hexId.toLowerCase() === selfHex) return false;
        if (!q) return true;
        return chatStore.getDisplayName(hexId).toLowerCase().includes(q);
      })
      .slice(0, 50);
  });

  /** Insert a mention at the trigger position (display-only in textarea). */
  const insertMention = (hexId: string) => {
    const el = textareaRef.value;
    if (!el) return;

    const rawName = chatStore.getDisplayName(hexId);
    const safeName = rawName.replace(/\s+/g, "_").replace(/[^\w]/g, "").slice(0, 50) || hexId.slice(0, 8);
    const displayMention = `@${safeName}`;
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
