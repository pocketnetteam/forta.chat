/**
 * Reasoning models (Qwen3 and others) wrap their internal chain-of-thought
 * in `<think>...</think>` before the real answer. `local-ai` only strips
 * this from the *final*, persisted message content — the live bubble shown
 * during streaming reads `aiChatStore.streamingContent`, which is the raw,
 * still-in-progress token accumulation (local-ai's own splitting only runs
 * once the whole generation settles) — so the raw tags were rendering
 * literally while a message was still generating (live bug, 2026-08-19).
 * This parses that raw, possibly-mid-stream text into reasoning vs. answer
 * so `AiChatView.vue` can show a "thinking" indicator while inside an
 * unclosed block and the real answer as it streams in past it, for both
 * the in-progress and already-settled cases.
 */
export interface ParsedThinking {
  /** Reasoning text (tags stripped, trimmed), or `null` if there was none. */
  thinking: string | null;
  /** True while a `<think>` tag has opened but not yet closed — no answer text exists yet. */
  isThinking: boolean;
  /** Everything outside the `<think>...</think>` block, trimmed. */
  answer: string;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export function parseThinking(raw: string): ParsedThinking {
  const openIdx = raw.indexOf(THINK_OPEN);
  if (openIdx === -1) return { thinking: null, isThinking: false, answer: raw };

  const before = raw.slice(0, openIdx);
  const closeIdx = raw.indexOf(THINK_CLOSE, openIdx + THINK_OPEN.length);

  if (closeIdx === -1) {
    // Still streaming inside the block — no answer content exists yet.
    const thinking = raw.slice(openIdx + THINK_OPEN.length).trim();
    return { thinking: thinking.length > 0 ? thinking : null, isThinking: true, answer: before.trim() };
  }

  const thinking = raw.slice(openIdx + THINK_OPEN.length, closeIdx).trim();
  const after = raw.slice(closeIdx + THINK_CLOSE.length);
  return { thinking: thinking.length > 0 ? thinking : null, isThinking: false, answer: (before + after).trim() };
}
