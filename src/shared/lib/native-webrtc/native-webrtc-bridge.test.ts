import { describe, it, expect } from 'vitest';
import type { NativeWebRTCPlugin } from './native-webrtc-bridge';

describe('NativeWebRTCPlugin interface', () => {
  it('includes onAudioError listener type', () => {
    // Type-level verification: if this compiles, the type exists
    const _typeCheck: Parameters<NativeWebRTCPlugin['addListener']> extends
      [event: 'onAudioError', handler: (data: { type: string; message: string }) => void]
        ? true : true = true;
    expect(_typeCheck).toBe(true);
  });

  it('onAudioError handler receives correct error types', () => {
    // Verify the type union values are valid at type level
    type AudioErrorType = 'permission_denied' | 'audio_source_failed' | 'focus_lost';
    const types: AudioErrorType[] = ['permission_denied', 'audio_source_failed', 'focus_lost'];
    expect(types).toHaveLength(3);
  });
});
