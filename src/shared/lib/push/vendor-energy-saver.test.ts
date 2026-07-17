import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  classifyVendor,
  isVendorHintDismissed,
  markVendorHintDismissed,
  VENDOR_HINT_DISMISSED_KEY,
} from './vendor-energy-saver';

describe('classifyVendor', () => {
  it('returns null for empty / nullish input', () => {
    expect(classifyVendor(null)).toBeNull();
    expect(classifyVendor(undefined)).toBeNull();
    expect(classifyVendor('')).toBeNull();
    expect(classifyVendor('   ')).toBeNull();
  });

  it('returns null for unknown manufacturers (Google Pixel, etc.)', () => {
    expect(classifyVendor('Google')).toBeNull();
    expect(classifyVendor('Pixel')).toBeNull();
    expect(classifyVendor('Nokia')).toBeNull();
  });

  it.each([
    ['Samsung', 'samsung'],
    ['samsung', 'samsung'],
    ['SAMSUNG', 'samsung'],
    ['HUAWEI', 'huawei'],
    ['HONOR', 'honor'],
    ['Xiaomi', 'xiaomi'],
    ['REDMI', 'xiaomi'],
    ['POCO', 'xiaomi'],
    ['OPPO', 'oppo'],
    ['OnePlus', 'oneplus'],
    ['oneplus', 'oneplus'],
    ['vivo', 'vivo'],
    ['realme', 'realme'],
  ] as const)('classifies %s → %s', (input, expected) => {
    const result = classifyVendor(input);
    expect(result?.id).toBe(expected);
    expect(result?.manufacturer).toBe(input.trim().toLowerCase());
  });

  it('trims whitespace before classifying', () => {
    expect(classifyVendor('  Samsung  ')?.id).toBe('samsung');
  });
});

describe('vendor hint dismissal persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports not-dismissed by default', () => {
    expect(isVendorHintDismissed('samsung')).toBe(false);
  });

  it('persists dismissal and reports it back', () => {
    markVendorHintDismissed('samsung');
    expect(isVendorHintDismissed('samsung')).toBe(true);
    // Other vendors stay un-dismissed
    expect(isVendorHintDismissed('xiaomi')).toBe(false);
  });

  it('does not duplicate the same vendor in storage', () => {
    markVendorHintDismissed('xiaomi');
    markVendorHintDismissed('xiaomi');
    const raw = localStorage.getItem(VENDOR_HINT_DISMISSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    expect(parsed.filter((v) => v === 'xiaomi')).toHaveLength(1);
  });

  it('accumulates dismissals across vendors', () => {
    markVendorHintDismissed('samsung');
    markVendorHintDismissed('xiaomi');
    expect(isVendorHintDismissed('samsung')).toBe(true);
    expect(isVendorHintDismissed('xiaomi')).toBe(true);
  });

  it('tolerates corrupt JSON in storage (treats as not-dismissed)', () => {
    localStorage.setItem(VENDOR_HINT_DISMISSED_KEY, 'not valid json{');
    expect(isVendorHintDismissed('samsung')).toBe(false);
    // Writing should still work (overwrites the corrupt value)
    markVendorHintDismissed('samsung');
    expect(isVendorHintDismissed('samsung')).toBe(true);
  });

  it('tolerates localStorage throwing (e.g. quota exceeded)', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota'); });
    try {
      // Must not throw
      expect(() => markVendorHintDismissed('samsung')).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});
