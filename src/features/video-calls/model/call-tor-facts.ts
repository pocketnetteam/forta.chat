/** Tor facts for call diagnostics and the user warning shown when a call bypasses Tor (split out of call-service.ts). */
import type { DiagnosticsWarningType } from "./webrtc-diagnostics";
import type { CallTorDiagnostics } from "@/shared/lib/bug-report";
import { registerCallDiagnosticsExtras } from "@/shared/lib/bug-report";
import { webrtcDiagnostics } from "./webrtc-diagnostics";
import { tRaw } from "@/shared/lib/i18n";
import { useToast } from "@/shared/lib/use-toast";

export const DIAGNOSTICS_WARNING_KEYS: Record<DiagnosticsWarningType, Parameters<typeof tRaw>[0]> = {
  no_inbound_audio: "call.warning.noInboundAudio",
  no_outbound_audio: "call.warning.noOutboundAudio",
  ice_failed_no_relay: "call.warning.noRelay",
};

/**
 * Tor state for the bug report and the call-start hint. Lazy import: the
 * Tor store drags the transport graph in, and this module is loaded on
 * every platform. Null when the store is unavailable (no Pinia yet).
 */
export async function torFacts(): Promise<CallTorDiagnostics | null> {
  try {
    const { useTorStore } = await import("@/entities/tor");
    const tor = useTorStore();
    return { enabled: tor.isEnabled, connected: tor.isConnected };
  } catch {
    return null;
  }
}

/**
 * O14: WebRTC media goes straight to the peer (UDP, no proxy), so a user
 * who turned Tor on is not covered by it during a call. Say so once per
 * call, at the moment the call is placed or answered.
 */
export async function warnIfCallBypassesTor(): Promise<void> {
  const tor = await torFacts();
  if (!tor?.enabled) return;
  try {
    useToast().toast(tRaw("call.warning.torBypassed"), "info", 6000);
  } catch (e) {
    console.warn("[call-service] tor hint toast failed:", e);
  }
}

// O05/O14: the bug report's call section gets the last connection's ICE
// facts and the Tor state from here; shared/ cannot import this feature.
registerCallDiagnosticsExtras(async () => ({
  ice: webrtcDiagnostics.getIceSummary(),
  tor: await torFacts(),
}));
