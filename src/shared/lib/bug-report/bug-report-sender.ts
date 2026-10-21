import type { BugReportInput } from './types';
import { computeReporterHash } from './reporter-hash';
import { postToBugReportProxy } from './bug-report-proxy';
import { scrubPii } from './scrub-pii';

const THUMB_MAX_WIDTH = 800;
const THUMB_QUALITY = 0.5;
/** The proxy takes 60 000; a longer report would be refused whole. */
const MAX_BODY_CHARS = 58_000;
const TRUNCATED_NOTE = '\n\n_The report was cut on the device to fit._';
/** Base64 length of the proxy's 2 MB screenshot cap. */
const MAX_SCREENSHOT_BASE64 = 2_796_000;
/** The proxy takes at most this many screenshots per report. */
const MAX_SCREENSHOTS = 5;

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

function formatTitle(platform: string, description: string): string {
  const prefix = `[${platform}] `;
  const maxLen = 100 - prefix.length;
  const trimmed =
    description.length > maxLen
      ? description.slice(0, maxLen - 1) + '\u2026'
      : description;
  return `${prefix}${trimmed}`;
}

/** Markdown of the report. The proxy adds the reporter marker and the screenshots. */
function formatBody(input: BugReportInput): string {
  const { description, environment: env } = input;

  const lines: string[] = [];

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
    // "Rings very quietly at full volume": a ringtone played in an in-call
    // audio mode goes to the earpiece. Telecom "none" = the ring ran without
    // Telecom, which never switches the phone to MODE_RINGTONE.
    if (diag.ringAudio?.length) {
      lines.push(
        '',
        '<details><summary>Incoming ring audio</summary>',
        '',
        '| # | time (UTC) | callId | mode at ring | stranded mode reset | mode in ring | Telecom |',
        '|---|------------|--------|--------------|---------------------|--------------|---------|',
      );
      diag.ringAudio.forEach((r, i) => {
        // A malformed record must not throw and take the whole report down.
        const time = Number.isFinite(r.atMs) ? new Date(r.atMs).toISOString().slice(11, 19) : '?';
        const callIdShort = r.callId ? r.callId.slice(0, 12) : '(none)';
        lines.push(
          `| ${i + 1} | ${time} | \`${callIdShort}\` | ${r.modeAtArm} | ${r.modeReset ? 'yes' : 'no'} | ${r.modeInRing || '—'} | ${r.telecom} |`,
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
  /** Null when the reports repository is private: the reporter could not open it. */
  issueUrl: string | null;
  issueNumber: number;
  /** Lets this device close or reopen the issue later; the proxy issues it once. */
  manageKey: string;
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

async function reporterHash(address: string | undefined): Promise<string | undefined> {
  if (!address) return undefined;
  try {
    return await computeReporterHash(address);
  } catch (e) {
    // The marker only groups reports; it must never block one.
    console.warn('[bug-report] reporter hash failed, sending without marker:', e);
    return undefined;
  }
}

/**
 * The proxy refuses the whole report over one screenshot that is not a JPEG
 * or PNG under 2 MB. One the canvas could not compress (HEIC, an undecodable
 * file) stays out instead.
 */
function isAcceptedScreenshot(base64: string): boolean {
  const isJpegOrPng = base64.startsWith('/9j/') || base64.startsWith('iVBOR');
  return isJpegOrPng && base64.length <= MAX_SCREENSHOT_BASE64;
}

function capBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS - TRUNCATED_NOTE.length) + TRUNCATED_NOTE;
}

export async function sendBugReport(
  input: BugReportInput,
): Promise<BugReportResult> {
  // Compressing is independent per screenshot, so it runs at once (audit W2D-03).
  const compressed = input.screenshots?.length
    ? await Promise.all(input.screenshots.map((s) => compressImage(s, THUMB_MAX_WIDTH, THUMB_QUALITY)))
    : [];
  const screenshots = compressed.filter(isAcceptedScreenshot).slice(0, MAX_SCREENSHOTS);
  const skipped = compressed.length - screenshots.length;

  const res = await postToBugReportProxy('/v1/reports', {
    title: scrubPii(formatTitle(input.environment.platform, input.description)),
    body: capBody(scrubPii(formatBody(input))),
    reporter: await reporterHash(input.reporterAddress),
    screenshots,
  });

  if (!res.ok) {
    throw new Error(`Failed to create issue: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.number !== 'number' || typeof data.manageKey !== 'string') {
    throw new Error('Failed to create issue: malformed proxy response');
  }
  const storeFailed = typeof data.screenshotsFailed === 'number' ? data.screenshotsFailed : 0;
  const storeError = typeof data.uploadError === 'string' ? data.uploadError : undefined;
  return {
    issueUrl: typeof data.url === 'string' ? data.url : null,
    issueNumber: data.number,
    manageKey: data.manageKey,
    screenshotsFailed: storeFailed + skipped,
    uploadError: storeError ?? (skipped > 0 ? 'unsupported image' : undefined),
  };
}
