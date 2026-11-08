import { setAudioDevice, setLocalVideoMuted, setVideoDevice, toggleCamera, toggleMute, toggleScreenShare } from "./call-media";
import { answerCall, currentCall, hangup, rejectCall, releaseOrphanedNativeAnswer } from "./call-answer";
import { startCall } from "./call-outgoing";
import { handleIncomingCall } from "./call-incoming";
export { MATRIX_READY_WAIT_MS } from "./call-outgoing";
// Registers the Tor and ICE facts for bug reports; keep it loaded with the service.
import "./call-tor-facts";

export function useCallService() {
  return {
    startCall,
    handleIncomingCall,
    answerCall,
    rejectCall,
    hangup,
    currentCall,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    setAudioDevice,
    setVideoDevice,
    setLocalVideoMuted,
    releaseOrphanedNativeAnswer,
  };
}
