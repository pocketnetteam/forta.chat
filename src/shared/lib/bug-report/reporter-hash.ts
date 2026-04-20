export const REPORTER_MARKER_PREFIX = 'reporter:';

const MARKER_REGEX = /<!--\s*reporter:([0-9a-f]{16})\s*-->/;

/**
 * Derive a stable 16-char hex hash from a Bastyon/Matrix address so we can
 * link GitHub issues back to their reporter without ever storing anything
 * that could identify the user. SHA-256 is one-way and the input has a fixed
 * salt so the mapping cannot be rainbow-tabled against an address list.
 */
export async function computeReporterHash(address: string): Promise<string> {
  if (!address) throw new Error('address is required');
  const data = new TextEncoder().encode(`forta-bug-reporter:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function buildReporterMarker(hash: string): string {
  return `<!-- ${REPORTER_MARKER_PREFIX}${hash} -->`;
}

export function extractReporterHashFromBody(
  body: string | undefined | null,
): string | null {
  if (!body) return null;
  const match = body.match(MARKER_REGEX);
  return match ? match[1] : null;
}
