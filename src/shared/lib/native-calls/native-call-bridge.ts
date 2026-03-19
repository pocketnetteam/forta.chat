import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';
import { NativeWebRTC } from '@/shared/lib/native-webrtc/native-webrtc-bridge';

interface NativeCallNativePlugin {
  reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void>;
  reportOutgoingCall(options: {
    callId: string;
    callerName: string;
    hasVideo: boolean;
  }): Promise<void>;
  reportCallConnected(options: { callId: string }): Promise<void>;
  reportCallEnded(options: { callId: string }): Promise<void>;
  requestAudioPermission(): Promise<{ granted: boolean }>;
  addListener(event: 'callAnswered', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callDeclined', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callEnded', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
}

const NativeCall = registerPlugin<NativeCallNativePlugin>('NativeCall');

class NativeCallBridge {
  private callService: any = null;

  async wire(callService: { answerCall: () => void; rejectCall: () => void; hangup: () => void }): Promise<void> {
    if (!isNative) return;
    this.callService = callService;

    // Request audio permission early so WebRTC can access microphone
    try {
      await NativeCall.requestAudioPermission();
    } catch (e) {
      console.warn('[NativeCallBridge] requestAudioPermission failed:', e);
    }

    await NativeCall.addListener('callAnswered', ({ callId }) => {
      console.log('[NativeCallBridge] Call answered:', callId);
      this.callService?.answerCall();
    });

    await NativeCall.addListener('callDeclined', ({ callId }) => {
      console.log('[NativeCallBridge] Call declined:', callId);
      this.callService?.rejectCall();
    });

    await NativeCall.addListener('callEnded', ({ callId }) => {
      console.log('[NativeCallBridge] Call ended natively:', callId);
      this.callService?.hangup();
    });

    // Native CallActivity hangup button → proper SDK hangup
    await NativeWebRTC.addListener('onNativeHangup', () => {
      console.log('[NativeCallBridge] Native UI hangup');
      this.callService?.hangup();
    });
  }

  async reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportIncomingCall(options);
  }

  async reportOutgoingCall(options: {
    callId: string;
    callerName: string;
    hasVideo: boolean;
  }): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.reportOutgoingCall(options);
    } catch (e) {
      console.warn('[NativeCallBridge] reportOutgoingCall failed:', e);
    }
  }

  async reportCallConnected(callId: string): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.reportCallConnected({ callId });
    } catch (e) {
      console.warn('[NativeCallBridge] reportCallConnected failed:', e);
    }
  }

  async reportCallEnded(callId: string): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportCallEnded({ callId });
  }
}

export const nativeCallBridge = new NativeCallBridge();
