/** Max length of a stored send-error description (keeps Dexie rows small). */
const MAX_SEND_ERROR_LENGTH = 1000;

/**
 * Human-readable one-line description of a send failure, stored on the
 * message (`LocalMessage.sendError`) so the user can see why it failed by
 * tapping the red (!) status icon. Includes Matrix `errcode` / HTTP status
 * when the error is a MatrixError — `String(e)` alone loses them.
 */
export function describeSendError(e: unknown): string {
  if (e === null || e === undefined) return "Unknown error";
  if (typeof e !== "object") return truncate(String(e));

  const err = e as {
    name?: unknown;
    message?: unknown;
    errcode?: unknown;
    httpStatus?: unknown;
    data?: { error?: unknown };
  };
  const parts: string[] = [];
  if (typeof err.errcode === "string" && err.errcode) parts.push(err.errcode);
  if (typeof err.httpStatus === "number") parts.push(`HTTP ${err.httpStatus}`);

  const message =
    (typeof err.message === "string" && err.message) ||
    (typeof err.data?.error === "string" && err.data.error) ||
    "";
  const name = typeof err.name === "string" && err.name !== "Error" ? err.name : "";
  const text = name && message ? `${name}: ${message}` : name || message;
  if (text) parts.push(text);

  return truncate(parts.length ? parts.join(" · ") : String(e));
}

function truncate(text: string): string {
  return text.length > MAX_SEND_ERROR_LENGTH ? `${text.slice(0, MAX_SEND_ERROR_LENGTH)}…` : text;
}
