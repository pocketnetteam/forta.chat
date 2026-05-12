import { describe, it, expect } from 'vitest';
import {
  ANDROID_RELEASE_URL,
  WEB_DOWNLOAD_FALLBACK_URL,
  IOS_APP_STORE_ID_PLACEHOLDER,
  IOS_APP_STORE_URL,
  detectBrowserPlatform,
  resolveDownloadUrl,
} from './download-links';

describe('detectBrowserPlatform', () => {
  it('identifies modern iOS Safari', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    expect(detectBrowserPlatform(ua)).toBe('ios');
  });

  it('identifies iPad Safari', () => {
    const ua =
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    expect(detectBrowserPlatform(ua)).toBe('ios');
  });

  it('identifies Android Chrome', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Mobile Safari/537.36';
    expect(detectBrowserPlatform(ua)).toBe('android');
  });

  it('returns "other" for desktop browsers', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'Version/17.4 Safari/605.1.15';
    expect(detectBrowserPlatform(ua)).toBe('other');
  });
});

describe('resolveDownloadUrl', () => {
  it('returns the GitHub release page for Android browsers', () => {
    expect(resolveDownloadUrl('android')).toBe(ANDROID_RELEASE_URL);
  });

  it('returns the web fallback while the App Store id is still a placeholder', () => {
    // Sanity check that the placeholder still ships — once a real id is set
    // this test should be updated to assert the real App Store URL.
    expect(IOS_APP_STORE_URL).toContain(IOS_APP_STORE_ID_PLACEHOLDER);
    expect(resolveDownloadUrl('ios')).toBe(WEB_DOWNLOAD_FALLBACK_URL);
  });

  it('returns the web fallback for unrecognised platforms', () => {
    expect(resolveDownloadUrl('other')).toBe(WEB_DOWNLOAD_FALLBACK_URL);
  });
});
