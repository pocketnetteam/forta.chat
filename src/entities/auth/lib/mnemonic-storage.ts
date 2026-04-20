/** Persistent short-lived storage for an in-progress registration mnemonic.
 *
 *  Why: The RegisterForm used to wipe `regMnemonic` in `onUnmounted`. Any
 *  route change, HMR, or Android background-kill between the "save mnemonic"
 *  step and blockchain confirmation destroyed the phrase irretrievably —
 *  users reported "seed phrase lost" after swiping the app away.
 *
 *  sessionStorage survives component unmounts but is scoped to the tab/session,
 *  so it is automatically cleaned up when the user closes the tab/app. We also
 *  clear it explicitly once registration confirms on-chain.
 *
 *  All calls are defensive: sessionStorage can throw (Safari private mode,
 *  storage full, etc.). Failures are logged but never propagate.
 */

export const MNEMONIC_STORAGE_KEY = "forta-chat:registration:mnemonic";

function getStorage(): Storage | null {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    /* sessionStorage access can throw in sandboxed contexts */
  }
  return null;
}

export function saveMnemonic(mnemonic: string): void {
  if (!mnemonic || !mnemonic.trim()) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(MNEMONIC_STORAGE_KEY, mnemonic);
  } catch (err) {
    console.warn("[mnemonic-storage] saveMnemonic failed:", err);
  }
}

export function loadMnemonic(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(MNEMONIC_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch (err) {
    console.warn("[mnemonic-storage] loadMnemonic failed:", err);
    return null;
  }
}

export function clearMnemonic(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(MNEMONIC_STORAGE_KEY);
  } catch (err) {
    console.warn("[mnemonic-storage] clearMnemonic failed:", err);
  }
}
