import { describe, it, expect } from 'vitest';
import type { TelemetrySnapshot } from '@/shared/lib/telemetry';
import type { SyncStateEntry } from '@/shared/lib/local-db';

/**
 * Extracted parsing logic matching SettingsPanel.vue's parsedTelemetry computed.
 * Tests the JSON-parse safety and edge cases without mounting the full component.
 */
function parseTelemetryEntry(
  entry: SyncStateEntry | undefined | null,
): TelemetrySnapshot | null {
  if (!entry || typeof entry.value !== 'string') return null;
  try {
    return JSON.parse(entry.value) as TelemetrySnapshot;
  } catch {
    return null;
  }
}

describe('parseTelemetryEntry (settings about)', () => {
  it('returns null for null entry', () => {
    expect(parseTelemetryEntry(null)).toBeNull();
  });

  it('returns null for undefined entry', () => {
    expect(parseTelemetryEntry(undefined)).toBeNull();
  });

  it('returns null for empty string value', () => {
    expect(parseTelemetryEntry({ key: 'device_telemetry', value: '' })).toBeNull();
  });

  it('parses valid JSON into TelemetrySnapshot', () => {
    const snapshot: TelemetrySnapshot = {
      collectedAt: 1700000000000,
      platform: 'android',
      webViewVersion: '124.0.6367.82',
      webViewMajor: 124,
      webViewState: 'outdated',
      androidVersion: '14',
      androidSdk: 34,
      deviceModel: 'Pixel 7',
      deviceManufacturer: 'Google',
      screenWidth: 1080,
      screenHeight: 2400,
      screenDpr: 2.75,
    };
    const entry: SyncStateEntry = {
      key: 'device_telemetry',
      value: JSON.stringify(snapshot),
    };
    const result = parseTelemetryEntry(entry);
    expect(result).toEqual(snapshot);
  });

  it('returns null for malformed JSON', () => {
    const entry: SyncStateEntry = {
      key: 'device_telemetry',
      value: '{broken json!!!',
    };
    expect(parseTelemetryEntry(entry)).toBeNull();
  });

  it('returns null for number value', () => {
    const entry: SyncStateEntry = {
      key: 'device_telemetry',
      value: 12345,
    };
    expect(parseTelemetryEntry(entry)).toBeNull();
  });
});
