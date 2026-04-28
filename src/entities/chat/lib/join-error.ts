/**
 * Pure helpers for Matrix room-join flow:
 *  - `validateRoomId` — syntactic check against Matrix room-id grammar.
 *    Keeps unsafe inputs from reaching joinRoom/peekInRoom and shares the
 *    exact shape check with `parse-invite-url` so validation never diverges.
 *  - `categorizeJoinError` — maps SDK errors to a typed `JoinRoomResult`.
 *
 * `errorMessage` contract:
 *   - For the "unknown" branch, it holds whatever raw message the SDK threw
 *     (network/timeout/other) — surfaced verbatim so the user sees the real
 *     failure.
 *   - For every other reason it holds an i18n KEY (e.g. "joinRoom.errorForbidden")
 *     when the caller passed an identity translator, or the already-localized
 *     string when the caller passed a real `t`. Callers MUST be consistent:
 *     either translate upfront via `t`, or re-translate at the render site.
 */

export type JoinRoomReason =
  | "banned"
  | "forbidden"
  | "not_found"
  | "invalid_id"
  | "unknown";

export type JoinRoomResult =
  | { ok: true }
  | { ok: false; reason: JoinRoomReason; errorMessage: string };

export const MATRIX_ROOM_ID_RE = /^![A-Za-z0-9._=+\-]+:[A-Za-z0-9.\-]+(:\d+)?$/;

export function validateRoomId(roomId: unknown): boolean {
  return typeof roomId === "string" && MATRIX_ROOM_ID_RE.test(roomId);
}

type ErrLike = {
  errcode?: string;
  message?: string;
  data?: { errcode?: string; error?: string };
};

/**
 * Map a thrown join/peek error to a typed result.
 * Accepts a translator so consumers get localized strings without this module
 * importing vue-i18n directly (keeps it unit-testable).
 */
export function categorizeJoinError(
  e: unknown,
  t: (key: string) => string,
): JoinRoomResult {
  const err = (e ?? {}) as ErrLike;
  const errcode = err.errcode ?? err.data?.errcode;

  if (errcode === "M_FORBIDDEN") {
    return {
      ok: false,
      reason: "forbidden",
      errorMessage: t("joinRoom.errorForbidden"),
    };
  }
  if (errcode === "M_NOT_FOUND") {
    return {
      ok: false,
      reason: "not_found",
      errorMessage: t("joinRoom.errorNotFound"),
    };
  }

  const fallback = err.message ?? err.data?.error;
  return {
    ok: false,
    reason: "unknown",
    errorMessage:
      typeof fallback === "string" && fallback.length > 0
        ? fallback
        : t("joinRoom.errorUnknown"),
  };
}
