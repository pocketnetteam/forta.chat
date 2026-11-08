/** SDK call state mapping and remote feed tracking for the call service (split out of call-service.ts). */
import { CallState as SDKCallState, type MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { CallStatus, useCallStore } from "@/entities/call";
import type { CallFeed, CallFeedEvent } from "matrix-js-sdk-bastyon/lib/webrtc/callFeed";
import { isNative } from "@/shared/lib/platform";
import { NativeWebRTC } from "@/shared/lib/native-webrtc";

export function mapSDKState(state: SDKCallState, direction: "outgoing" | "incoming"): CallStatus {
  switch (state) {
    case SDKCallState.Ringing:
      return direction === "outgoing" ? CallStatus.ringing : CallStatus.incoming;
    case SDKCallState.Connecting:
    case SDKCallState.CreateOffer:
    case SDKCallState.CreateAnswer:
    case SDKCallState.InviteSent:
    case SDKCallState.WaitLocalMedia:
      return CallStatus.connecting;
    case SDKCallState.Connected:
      return CallStatus.connected;
    case SDKCallState.Ended:
      return CallStatus.ended;
    default:
      return CallStatus.connecting;
  }
}

// ---------------------------------------------------------------------------
// Feed helpers — use SDK typed getters (#7)
// ---------------------------------------------------------------------------

export function updateFeeds(call: MatrixCall) {
  const callStore = useCallStore();
  try {
    // Local: always camera feed (for PiP), never screenshare
    callStore.setLocalStream(call.localUsermediaStream ?? null);
    // Local screen share stream (for self-preview when sharing)
    callStore.setLocalScreenStream(call.localScreensharingStream ?? null);
    // Remote camera (usermedia only — carries audio track too)
    callStore.setRemoteStream(call.remoteUsermediaStream ?? null);
    // Remote screen share as a separate stream
    callStore.setRemoteScreenStream(call.remoteScreensharingStream ?? null);
    callStore.remoteScreenSharing = !!call.remoteScreensharingStream;
    // Sync remote video mute state + wire listener
    syncRemoteVideoMuted(call);
  } catch (e) {
    console.warn("[call-service] updateFeeds error:", e);
  }
}

// ---------------------------------------------------------------------------
// Remote video mute detection
// ---------------------------------------------------------------------------

let trackedRemoteFeed: CallFeed | null = null;

let remoteFeedMuteHandler: ((audioMuted: boolean, videoMuted: boolean) => void) | null = null;

let remoteFeedStreamHandler: (() => void) | null = null;

/** The feed's track-change event; the SDK enum is imported as a type only. */
const FEED_NEW_STREAM = "new_stream" as CallFeedEvent.NewStream;

export function cleanupRemoteFeedListener() {
  if (trackedRemoteFeed && remoteFeedMuteHandler) {
    try {
      trackedRemoteFeed.off("mute_state_changed" as any, remoteFeedMuteHandler);
    } catch { /* ignore */ }
  }
  if (trackedRemoteFeed && remoteFeedStreamHandler) {
    try {
      trackedRemoteFeed.off(FEED_NEW_STREAM, remoteFeedStreamHandler);
    } catch { /* ignore */ }
  }
  trackedRemoteFeed = null;
  remoteFeedMuteHandler = null;
  remoteFeedStreamHandler = null;
}

export function syncRemoteVideoMuted(call: MatrixCall) {
  const callStore = useCallStore();
  const remoteFeed = call.remoteUsermediaFeed as CallFeed | undefined;

  /** Upgrade call type to "video" when remote peer enables camera */
  const maybeUpgradeToVideo = (videoMuted: boolean) => {
    if (!videoMuted && callStore.activeCall?.type === "voice") {
      callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
    }
  };

  /**
   * Re-reads the feed after its tracks may have changed and tells the native
   * call screen only when the answer did. isVideoMuted() counts tracks, and
   * with the native engine each remote track arrives as its own event: the
   * feed starts with the audio track alone and reads muted until the video
   * track joins it.
   */
  const resyncFromFeed = (feed: CallFeed) => {
    const videoMuted = feed.isVideoMuted();
    const changed = videoMuted !== callStore.remoteVideoMuted;
    callStore.remoteVideoMuted = videoMuted;
    maybeUpgradeToVideo(videoMuted);
    if (isNative && changed) {
      NativeWebRTC.updateRemoteVideoState({ muted: videoMuted }).catch(() => {});
    }
  };

  // If feed changed, re-wire listener
  if (remoteFeed !== trackedRemoteFeed) {
    cleanupRemoteFeedListener();

    if (remoteFeed) {
      const initialMuted = remoteFeed.isVideoMuted();
      callStore.remoteVideoMuted = initialMuted;
      maybeUpgradeToVideo(initialMuted);
      if (isNative) {
        NativeWebRTC.updateRemoteVideoState({ muted: initialMuted }).catch(() => {});
      }
      remoteFeedMuteHandler = (_audioMuted: boolean, videoMuted: boolean) => {
        callStore.remoteVideoMuted = videoMuted;
        maybeUpgradeToVideo(videoMuted);
        if (isNative) {
          NativeWebRTC.updateRemoteVideoState({ muted: videoMuted }).catch(() => {});
        }
      };
      trackedRemoteFeed = remoteFeed;
      remoteFeed.on("mute_state_changed" as any, remoteFeedMuteHandler);
      const onNewStream = () => resyncFromFeed(remoteFeed);
      remoteFeedStreamHandler = onNewStream;
      remoteFeed.on(FEED_NEW_STREAM, onNewStream);
    } else {
      // No remote feed yet → treat as muted
      callStore.remoteVideoMuted = true;
    }
  } else if (remoteFeed) {
    // Same feed: its tracks may have changed since it was wired
    resyncFromFeed(remoteFeed);
  }
}

// ---------------------------------------------------------------------------
// Event listener lifecycle (#1)
// ---------------------------------------------------------------------------
