/**
 * Derive a stable 16-char hex hash from a Bastyon/Matrix address so reports
 * of one reporter can be grouped. The salt is public and Bastyon addresses are
 * public, so this hash alone does not hide the reporter: the bug-report proxy
 * keys it with its secret before it writes the marker into the issue (audit
 * S10-06).
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
