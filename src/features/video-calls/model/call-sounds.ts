let audioContext: AudioContext | null = null;
let activeOscillators: OscillatorNode[] = [];
let activeGains: GainNode[] = [];
let ringtoneInterval: ReturnType<typeof setInterval> | null = null;
const trackedTimeouts = new Set<ReturnType<typeof setTimeout>>();

function trackedTimeout(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    trackedTimeouts.delete(id);
    fn();
  }, delay);
  trackedTimeouts.add(id);
  return id;
}

function getContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function cleanup() {
  for (const osc of activeOscillators) {
    try { osc.stop(); } catch { /* already stopped */ }
    try { osc.disconnect(); } catch { /* ignore */ }
  }
  for (const gain of activeGains) {
    try { gain.disconnect(); } catch { /* ignore */ }
  }
  activeOscillators = [];
  activeGains = [];
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  // Cancel all tracked timeouts
  for (const id of trackedTimeouts) {
    clearTimeout(id);
  }
  trackedTimeouts.clear();
}

function playTone(freq1: number, freq2: number, duration: number) {
  const ctx = getContext();
  const gain = ctx.createGain();
  gain.gain.value = 0.15;
  gain.connect(ctx.destination);
  activeGains.push(gain);

  const osc1 = ctx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.value = freq1;
  osc1.connect(gain);
  osc1.start();
  activeOscillators.push(osc1);

  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = freq2;
  osc2.connect(gain);
  osc2.start();
  activeOscillators.push(osc2);

  if (duration > 0) {
    trackedTimeout(() => {
      try { osc1.stop(); } catch { /* ignore */ }
      try { osc2.stop(); } catch { /* ignore */ }
    }, duration);
  }
}

/** Incoming call ringtone: dual-tone ring, 2s on / 4s off */
export function playRingtone() {
  cleanup();
  const ring = () => playTone(440, 480, 2000);
  ring();
  ringtoneInterval = setInterval(ring, 6000);
}

/** Outgoing dial tone: single ringback tone, 1s on / 3s off */
export function playDialtone() {
  cleanup();
  const ring = () => playTone(440, 480, 1000);
  ring();
  ringtoneInterval = setInterval(ring, 4000);
}

/** Short beep on call end */
export function playEndTone() {
  const ctx = getContext();
  const gain = ctx.createGain();
  gain.gain.value = 0.1;
  gain.connect(ctx.destination);
  activeGains.push(gain);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 480;
  osc.connect(gain);
  osc.start();
  activeOscillators.push(osc);

  trackedTimeout(() => {
    try { osc.stop(); } catch { /* ignore */ }
    try { gain.disconnect(); } catch { /* ignore */ }
  }, 300);
}

/** Stop all active sounds */
export function stopAllSounds() {
  cleanup();
}

/** Fully close AudioContext — call on logout/app teardown */
export function dispose() {
  cleanup();
  if (audioContext) {
    audioContext.close().catch(() => { /* ignore */ });
    audioContext = null;
  }
}
