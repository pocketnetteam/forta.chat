/**
 * Pure emoji-insertion helper extracted from MessageInput for WEE-48 /
 * forta-bugs#483, #489. The original inline implementation mutated v-model
 * state but never re-ran the @input pipeline (mention autocomplete, typing
 * throttle), so the input felt "frozen" after a picker selection and users
 * had to leave the chat to recover. Keeping the math pure lets us cover
 * cursor preservation + multi-emoji insertion in isolation.
 */

export interface InsertEmojiInput {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  emoji: string;
}

export interface InsertEmojiResult {
  text: string;
  /** New cursor position after insertion — same value for start and end. */
  cursor: number;
  /** True when the helper actually mutated the text. False on no-op (empty emoji). */
  changed: boolean;
}

/** Insert `emoji` at the current selection and report the new cursor. */
export const insertEmojiAtCursor = (input: InsertEmojiInput): InsertEmojiResult => {
  if (!input.emoji) {
    return { text: input.text, cursor: input.selectionStart, changed: false };
  }
  const start = clamp(input.selectionStart, 0, input.text.length);
  const end = clamp(Math.max(input.selectionEnd, start), 0, input.text.length);
  const next = input.text.slice(0, start) + input.emoji + input.text.slice(end);
  return {
    text: next,
    cursor: start + input.emoji.length,
    changed: true,
  };
};

const clamp = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
};
