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
  compressed: string,
  index: number,
): Promise<ScreenshotResult> {
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
    try {
      const hash = await computeReporterHash(input.reporterAddress);
      lines.push(buildReporterMarker(hash), '');
    } catch (e) {
      // Marker is a nice-to-have for status tracking — never let it block
      // the bug report itself. Log so we can diagnose if it ever happens.
      console.warn('[bug-report] reporter hash failed, sending without marker:', e);
    }
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

  // Session 25 / S3-S4: call-pipeline diagnostics. Rendered only when
  // present so non-call bug reports stay short. Layout chosen so triage
  // can scan delivery-latency at a glance and reach for the issue label
  // (`s4-stale-invite`, `s3-fcm-throttle`, etc.) without a repro.
  const diag = input.callDiagnostics;
  if (diag) {
    lines.push(
      '',
      '## Call diagnostics',
      '| Field | Value |',
      '|-------|-------|',
      `| WebRTC engine | ${diag.webrtcEngine} |`,
      `| Audio mode | ${diag.audioMode} |`,
      `| Speaker on | ${diag.isSpeakerOn ? 'yes' : 'no'} |`,
      `| BT SCO on | ${diag.isBtScoOn ? 'yes' : 'no'} |`,
      `| Recent invites | ${diag.inviteHistory.length} |`,
      `| Expired invites | ${diag.expiredInviteCount} |`,
    );
    // O10: a revoked full-screen intent is the usual reason an incoming
    // call "did not ring" on Android 14+ sideloads.
    if (diag.fullScreenIntentAllowed != null) {
      lines.push(`| Full-screen intent | ${diag.fullScreenIntentAllowed ? 'allowed' : 'REVOKED' } |`);
    }
    // O05/O14: relay=0 with a failed ICE state is the "no TURN reachable"
    // signature; the Tor row explains a peer that saw the reporter's IP.
    if (diag.ice) {
      lines.push(
        `| ICE candidates | relay=${diag.ice.relay} host=${diag.ice.host} srflx=${diag.ice.srflx} (TURN servers: ${diag.ice.turnServers ?? '?'}) |`,
        `| ICE result | ${diag.ice.lastIceState ?? '?'} via ${diag.ice.selectedPairType ?? 'no pair'} |`,
      );
    }
    if (diag.tor) {
      const torState = !diag.tor.enabled
        ? 'off'
        : diag.tor.connected
          ? 'on — calls bypass Tor'
          : 'enabled, not connected';
      lines.push(`| Tor during calls | ${torState} |`);
    }
    if (diag.inviteHistory.length > 0) {
      lines.push(
        '',
        '<details><summary>FCM invite history</summary>',
        '',
        '| # | callId | latency (ms) | expired | FCM priority | outcome |',
        '|---|--------|--------------|---------|--------------|---------|',
      );
      diag.inviteHistory.forEach((r, i) => {
        const callIdShort = r.callId ? r.callId.slice(0, 12) : '(none)';
        const latency = r.sentTimeSource === 'missing' ? 'no send time' : String(r.deliveryLatencyMs);
        lines.push(
          `| ${i + 1} | \`${callIdShort}\` | ${latency} | ${r.expired ? 'yes' : 'no'} | ${formatFcmPriority(r.priority, r.originalPriority)} | ${r.outcome ?? '?'} |`,
        );
      });
      lines.push('</details>');
    }
    // The ordered event list is what distinguishes "never left MODE_RINGTONE"
    // from "fell back into it after hangup". Collapsed so the report stays
    // scannable; times are relative to the first event.
    if (diag.audioTimeline.length > 0) {
      lines.push(
        '',
        '<details><summary>Audio timeline</summary>',
        '',
        '| t (ms) | event | detail |',
        '|--------|-------|--------|',
      );
      diag.audioTimeline.forEach((e) => {
        lines.push(`| ${e.atMs} | ${e.event} | ${e.detail || '—'} |`);
      });
      lines.push('</details>');
    }
  }

  const enc = input.encryptionDiagnostics;
  if (enc) {
    const counts = Object.entries(enc.queue).map(([status, n]) => `${status}=${n}`).join(' ');
    lines.push(
      '',
      '## Encryption diagnostics',
      '| Field | Value |',
      '|-------|-------|',
      `| Undecrypted messages | ${counts} |`,
      `| Rooms affected | ${enc.roomsAffected} |`,
      `| Oldest | ${enc.oldestHours} h |`,
    );
    for (const { error, count } of enc.topErrors) {
      lines.push(`| Error ×${count} | ${error.replace(/\|/g, '/')} |`);
    }
  }

  // Roadmap 7.6 (docs/plans/llama2): `local-ai` log export — collapsed by
  // default, same as the invite-history block above, so a non-AI report
  // stays short.
  const aiDiag = input.aiDiagnostics;
  if (aiDiag) {
    lines.push(
      '',
      '<details><summary>local-ai logs</summary>',
      '',
      '```',
      aiDiag.logs,
      '```',
      '</details>',
    );
  }

  return lines.join('\n');
}

export interface BugReportResult {
  issueUrl: string;
  issueNumber: number;
  screenshotsFailed: number;
  uploadError?: string;
}

const FCM_PRIORITY_NAMES: Record<number, string> = { 1: 'high', 2: 'normal' };

/** FCM priority of an invite push; a push sent high and delivered lower was
 *  downgraded by FCM (quota, Doze) rather than delayed by the network. */
export function formatFcmPriority(priority?: number, originalPriority?: number): string {
  if (priority === undefined) return '?';
  const name = FCM_PRIORITY_NAMES[priority] ?? 'unknown';
  if (originalPriority !== undefined && originalPriority !== priority && FCM_PRIORITY_NAMES[originalPriority]) {
    return `${name} (sent ${FCM_PRIORITY_NAMES[originalPriority]})`;
  }
  return name;
}

export async function sendBugReport(
  input: BugReportInput,
): Promise<BugReportResult> {
  const token = getToken();

  const results: ScreenshotResult[] = [];
  if (input.screenshots?.length) {
    // Compressing is independent per screenshot, so it runs at once (audit
    // W2D-03). The uploads stay one after another: each Contents API PUT is a
    // commit on the same branch, and concurrent ones fail with 409.
    const compressed = await Promise.all(
      input.screenshots.map((s) => compressImage(s, THUMB_MAX_WIDTH, THUMB_QUALITY)),
    );
    for (let i = 0; i < compressed.length; i++) {
      results.push(await uploadScreenshot(token, compressed[i], i));
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
