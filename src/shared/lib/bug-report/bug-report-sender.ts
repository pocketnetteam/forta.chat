import type { BugReportInput } from './types';
import { buildReporterMarker, computeReporterHash } from './reporter-hash';

const REPO = 'greenShirtMystery/forta-bugs';
const API_BASE = 'https://api.github.com';
const THUMB_MAX_WIDTH = 800;
const THUMB_QUALITY = 0.5;

/**
 * Compress a base64 image via canvas.
 * Returns raw base64 string (no data: prefix).
 */
function compressImage(
  base64: string,
  maxWidth: number,
  quality: number,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale =
        img.width > maxWidth ? maxWidth / img.width : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);

      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = () => resolve(base64);
    // Try png first, then jpeg — covers both source formats
    img.src = base64.startsWith('/9j/')
      ? `data:image/jpeg;base64,${base64}`
      : `data:image/png;base64,${base64}`;
  });
}

function getToken(): string {
  const token = import.meta.env.VITE_BUG_REPORT_TOKEN;
  if (!token) throw new Error('Bug report token not configured');
  return token;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

interface ScreenshotResult {
  url?: string;
  /** Tiny compressed base64 as fallback when upload fails */
  thumbBase64?: string;
  error?: string;
}

async function uploadScreenshot(
  token: string,
  base64Data: string,
  index: number,
): Promise<ScreenshotResult> {
  const compressed = await compressImage(base64Data, THUMB_MAX_WIDTH, THUMB_QUALITY);

  try {
    const filename = `${Date.now()}-${index}.jpg`;
    const path = `bug-screenshots/${filename}`;

    const res = await fetch(`${API_BASE}/repos/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({
        message: `bug-report: screenshot ${filename}`,
        content: compressed,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return { url: data.content.download_url as string };
    }

    const errorBody = await res.text().catch(() => '');
    return {
      thumbBase64: compressed,
      error: `upload ${res.status}: ${errorBody.slice(0, 200)}`,
    };
  } catch (e) {
    return {
      thumbBase64: compressed,
      error: e instanceof Error ? e.message : 'network error',
    };
  }
}

function formatTitle(platform: string, description: string): string {
  const prefix = `[${platform}] `;
  const maxLen = 100 - prefix.length;
  const trimmed =
    description.length > maxLen
      ? description.slice(0, maxLen - 1) + '\u2026'
      : description;
  return `${prefix}${trimmed}`;
}

async function formatBody(
  input: BugReportInput,
  results: ScreenshotResult[],
): Promise<string> {
  const { description, environment: env } = input;

  const lines: string[] = [];

  if (input.reporterAddress) {
    const hash = await computeReporterHash(input.reporterAddress);
    lines.push(buildReporterMarker(hash), '');
  }

  lines.push(
    '## Description',
    description,
    '',
    '## Environment',
    '| Field | Value |',
    '|-------|-------|',
    `| Platform | ${env.platform} |`,
    `| Version | ${env.appVersion || 'n/a'} |`,
    `| Build | ${env.buildNumber || 'n/a'} |`,
    `| WebView | ${env.webViewVersion || 'n/a'} |`,
    `| OS | ${env.osVersion || 'n/a'} |`,
    `| Device | ${env.deviceModel || 'n/a'} |`,
    `| Screen | ${env.screen} |`,
    `| Locale | ${env.locale} |`,
    `| Network | ${env.networkType} |`,
    `| Tor | ${env.torStatus} |`,
    `| Matrix | ${env.matrixReady ? 'ready' : 'not ready'} |`,
    `| Route | \`${env.currentRoute}\` |`,
    `| Uptime | ${env.uptime} |`,
    `| Memory | ${env.memoryMb} MB |`,
    '',
    '<details><summary>User Agent</summary>',
    '',
    '```',
    env.userAgent,
    '```',
    '</details>',
  );

  const uploaded = results.filter((r) => r.url);
  const failed = results.filter((r) => !r.url && r.thumbBase64);

  if (uploaded.length > 0) {
    lines.push('', '## Screenshots');
    for (const r of uploaded) {
      lines.push(`![screenshot](${r.url})`);
    }
  }

  if (failed.length > 0) {
    lines.push(
      '',
      `## Screenshots (upload failed: ${failed[0].error})`,
      '',
      '_Base64-encoded thumbnails below. Decode with any base64-to-image tool._',
    );
    for (let i = 0; i < failed.length; i++) {
      lines.push(
        '',
        `<details><summary>Screenshot ${i + 1}</summary>`,
        '',
        '```',
        failed[i].thumbBase64!,
        '```',
        '</details>',
      );
    }
  }

  return lines.join('\n');
}

export interface BugReportResult {
  issueUrl: string;
  issueNumber: number;
  screenshotsFailed: number;
  uploadError?: string;
}

export async function sendBugReport(
  input: BugReportInput,
): Promise<BugReportResult> {
  const token = getToken();

  const results: ScreenshotResult[] = [];
  if (input.screenshots?.length) {
    for (let i = 0; i < input.screenshots.length; i++) {
      results.push(await uploadScreenshot(token, input.screenshots[i], i));
    }
  }

  const body = await formatBody(input, results);

  const res = await fetch(`${API_BASE}/repos/${REPO}/issues`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      title: formatTitle(input.environment.platform, input.description),
      body,
      labels: ['bug-report'],
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create issue: ${res.status}`);
  }

  const data = await res.json();
  const failedScreenshots = results.filter((r) => !r.url && r.thumbBase64);

  return {
    issueUrl: data.html_url as string,
    issueNumber: data.number as number,
    screenshotsFailed: failedScreenshots.length,
    uploadError: failedScreenshots[0]?.error,
  };
}
