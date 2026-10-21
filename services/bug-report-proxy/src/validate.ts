/** A request the proxy refuses; the message is safe to return to the app. */
export class ValidationError extends Error {}

export const MAX_TITLE_CHARS = 256;
/** GitHub takes 65 536; the rest is for the reporter marker and the screenshots. */
export const MAX_BODY_CHARS = 60_000;
export const MAX_COMMENT_CHARS = 2_000;
export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

const REPORTER_RE = /^[0-9a-f]{16}$/;
const MANAGE_KEY_RE = /^[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ImageExtension = 'jpg' | 'png';

export interface Screenshot {
  base64: string;
  extension: ImageExtension;
}

export interface ReportRequest {
  title: string;
  body: string;
  /** SHA-256 of the reporter address, from the app. */
  reporter: string | null;
  screenshots: Screenshot[];
}

export interface StateChangeRequest {
  state: 'open' | 'closed';
  comment: string;
  manageKey: string;
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required`);
  if (trimmed.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return trimmed;
}

/** Decoded size of a base64 string. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The image type from the first bytes; null for anything but JPEG and PNG. */
export function sniffImage(base64: string): ImageExtension | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 12));
  } catch {
    return null;
  }
  const bytes = Array.from(head, (c) => c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

function screenshots(value: unknown): Screenshot[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('screenshots must be an array');
  if (value.length > MAX_SCREENSHOTS) throw new ValidationError(`at most ${MAX_SCREENSHOTS} screenshots`);
  return value.map((item, i) => {
    if (typeof item !== 'string' || !BASE64_RE.test(item)) {
      throw new ValidationError(`screenshot ${i + 1} is not base64`);
    }
    if (base64Bytes(item) > MAX_SCREENSHOT_BYTES) {
      throw new ValidationError(`screenshot ${i + 1} is larger than ${MAX_SCREENSHOT_BYTES} bytes`);
    }
    const extension = sniffImage(item);
    if (!extension) throw new ValidationError(`screenshot ${i + 1} is not a JPEG or PNG image`);
    return { base64: item, extension };
  });
}

export function parseReport(raw: unknown): ReportRequest {
  const o = asObject(raw);
  const reporter = o.reporter;
  if (reporter !== undefined && reporter !== null && (typeof reporter !== 'string' || !REPORTER_RE.test(reporter))) {
    throw new ValidationError('reporter must be 16 hex characters');
  }
  return {
    title: text(o.title, 'title', MAX_TITLE_CHARS, true),
    body: text(o.body, 'body', MAX_BODY_CHARS, true),
    reporter: typeof reporter === 'string' ? reporter : null,
    screenshots: screenshots(o.screenshots),
  };
}

export function parseStateChange(raw: unknown): StateChangeRequest {
  const o = asObject(raw);
  if (o.state !== 'open' && o.state !== 'closed') throw new ValidationError('state must be open or closed');
  if (typeof o.manageKey !== 'string' || !MANAGE_KEY_RE.test(o.manageKey)) {
    throw new ValidationError('manageKey is missing or malformed');
  }
  return {
    state: o.state,
    comment: text(o.comment, 'comment', MAX_COMMENT_CHARS, false),
    manageKey: o.manageKey,
  };
}

/**
 * Text from the app goes out under the proxy's GitHub account. An @mention
 * would notify any GitHub user, and a reporter marker would pose as another
 * reporter's.
 */
export function sanitizeForGitHub(value: string): string {
  return value
    .replace(/<!--\s*reporter:[^>]*-->/gi, '')
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​');
}
