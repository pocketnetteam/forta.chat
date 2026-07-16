/**
 * Username validation — Bastyon parity (WEE-78).
 *
 * Forta and Bastyon share one blockchain identity, so a name registered in
 * Forta must be accepted by Bastyon too. Bastyon's name rule (mirrored by
 * pocketnet's `clearname`, which strips everything outside `[a-zA-Z0-9_. *]`,
 * and confirmed by bug reports #418/#947/#417) forbids `@ # & -` and spaces.
 *
 * We therefore validate against the conservative Bastyon-compatible subset:
 * latin letters, digits, dot and underscore. Cyrillic is excluded because the
 * blockchain rejects it at `sendrawtransaction`. Any name accepted here is
 * guaranteed to be a valid Bastyon name, so the created account always works.
 */

// Allowed: latin letters, digits, dot, underscore.
// Forbidden (unlike the old, too-permissive regex): @ # & hyphen and spaces.
export const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
export const USERNAME_MAX_LENGTH = 20;
export const RESERVED_NAMES = ["pocketnet", "bastyon"] as const;

export type UsernameValidationError =
  | { code: "tooLong"; max: number }
  | { code: "invalidChars" }
  | { code: "reserved"; name: string };

/**
 * Validate a username against Bastyon rules.
 *
 * Returns `null` when the value is valid (or empty — emptiness is handled by
 * the `required` field), otherwise a structured error the UI maps to i18n copy.
 * Pure and i18n-free so it can be unit-tested in isolation.
 */
export const validateUsername = (value: string): UsernameValidationError | null => {
  const trimmed = value.trim();
  if (!trimmed) return null; // empty is handled by `required`
  if (trimmed.length > USERNAME_MAX_LENGTH) {
    return { code: "tooLong", max: USERNAME_MAX_LENGTH };
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    return { code: "invalidChars" };
  }
  // Reserved names: case-insensitive, after stripping non-alpha characters
  // so "b.a.s.t.y.o.n" or "Bastyon_" can't slip through.
  const normalized = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  for (const reserved of RESERVED_NAMES) {
    if (normalized.includes(reserved)) {
      return { code: "reserved", name: reserved };
    }
  }
  return null;
};

/** Convenience boolean form of {@link validateUsername}. */
export const isValidUsername = (value: string): boolean => validateUsername(value) === null;
