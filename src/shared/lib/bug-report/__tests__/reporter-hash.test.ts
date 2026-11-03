import { describe, it, expect } from 'vitest';
import { computeReporterHash } from '../reporter-hash';

describe('computeReporterHash', () => {
  it('returns a 16-char lowercase hex string', async () => {
    const hash = await computeReporterHash('PNWnVB2kvNSf9ZE6vTJxyRgS3Pq4BBP7wp');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same address', async () => {
    const a = await computeReporterHash('addr-1');
    const b = await computeReporterHash('addr-1');
    expect(a).toBe(b);
  });

  it('differs for different addresses', async () => {
    const a = await computeReporterHash('addr-1');
    const b = await computeReporterHash('addr-2');
    expect(a).not.toBe(b);
  });

  it('throws on empty address', async () => {
    await expect(computeReporterHash('')).rejects.toThrow();
  });
});
