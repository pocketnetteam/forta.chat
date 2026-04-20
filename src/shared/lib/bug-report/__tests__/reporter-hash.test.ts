import { describe, it, expect } from 'vitest';
import {
  computeReporterHash,
  buildReporterMarker,
  extractReporterHashFromBody,
  REPORTER_MARKER_PREFIX,
} from '../reporter-hash';

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

describe('REPORTER_MARKER_PREFIX', () => {
  it('is "reporter:"', () => {
    expect(REPORTER_MARKER_PREFIX).toBe('reporter:');
  });
});

describe('buildReporterMarker', () => {
  it('wraps hash in HTML comment with prefix', () => {
    expect(buildReporterMarker('abc1234567890def')).toBe(
      '<!-- reporter:abc1234567890def -->',
    );
  });
});

describe('extractReporterHashFromBody', () => {
  it('extracts the hash from a body containing the marker', () => {
    const body = '<!-- reporter:0123456789abcdef -->\n\n## Description\nfoo';
    expect(extractReporterHashFromBody(body)).toBe('0123456789abcdef');
  });

  it('tolerates whitespace around the marker', () => {
    expect(extractReporterHashFromBody('<!--   reporter:abcdef0123456789   -->'))
      .toBe('abcdef0123456789');
  });

  it('returns null when marker missing', () => {
    expect(extractReporterHashFromBody('## Description\nfoo')).toBeNull();
  });

  it('returns null for undefined / null / empty input', () => {
    expect(extractReporterHashFromBody(undefined)).toBeNull();
    expect(extractReporterHashFromBody(null)).toBeNull();
    expect(extractReporterHashFromBody('')).toBeNull();
  });

  it('ignores malformed hashes (wrong length / non-hex)', () => {
    expect(extractReporterHashFromBody('<!-- reporter:abc -->')).toBeNull();
    expect(extractReporterHashFromBody('<!-- reporter:ZZZZZZZZZZZZZZZZ -->')).toBeNull();
  });
});
