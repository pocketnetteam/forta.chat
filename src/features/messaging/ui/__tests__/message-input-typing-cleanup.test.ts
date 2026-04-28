import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level regression tests for typing-indicator cleanup in MessageInput.vue.
 *
 * Bug history: when the user navigated to another chat (or unmounted the
 * component) we never sent `setTyping(false)` for the old room, so peers saw
 * the indicator hanging until the server-side timeout (~20–30s).
 * Additionally, we used `chatStore.activeRoomId` for the stop call, which
 * already pointed at the NEW room by the time the watcher fired.
 *
 * These tests guard the structural shape of the fix so it cannot silently
 * regress during refactors. The actual `setTyping(roomIdOverride)` plumbing
 * is covered by behavioral tests in `use-messages.test.ts`.
 */

const getSource = () =>
  readFileSync(resolve(__dirname, "../MessageInput.vue"), "utf-8");

describe("MessageInput typing cleanup", () => {
  it("stops typing in the OLD room when activeRoomId changes", () => {
    const source = getSource();
    const watchStart = source.indexOf("() => chatStore.activeRoomId");
    expect(watchStart).toBeGreaterThan(-1);
    // Slice the watcher body — be generous, the watcher is ~40 lines.
    const watchBody = source.slice(watchStart, watchStart + 2000);

    // Must call setTyping(false, oldId) — passing oldId explicitly is the
    // whole point: activeRoomId already points at newId here.
    expect(watchBody).toMatch(/setTyping\(\s*false\s*,\s*oldId\s*\)/);
  });

  it("stops typing in the active room on component unmount", () => {
    const source = getSource();
    const unmountStart = source.indexOf("onBeforeUnmount(()");
    expect(unmountStart).toBeGreaterThan(-1);
    const unmountBody = source.slice(unmountStart, unmountStart + 800);

    expect(unmountBody).toMatch(/setTyping\(\s*false\s*,\s*roomId\s*\)/);
  });

  it("uses a 3-second idle-stop debounce (not the legacy 5s)", () => {
    const source = getSource();
    expect(source).toMatch(/TYPING_IDLE_STOP_MS\s*=\s*3000/);
    // The literal `5000` for typing must be gone — the only debounce we
    // care about here is the typing one. We assert via the named constant
    // to avoid catching unrelated 5000ms timers elsewhere in the file.
    expect(source).not.toMatch(/setTyping\(false\)[^;]*\}\s*,\s*5000/);
  });

  it("clears throttle and pending stop at each setTyping(false) site", () => {
    const source = getSource();
    expect(source).toMatch(/const resetTypingTimers\s*=\s*\(\)/);

    // Each of the three sites that explicitly stop typing — handleSend,
    // onBeforeUnmount, and the activeRoomId watcher — must also call
    // resetTypingTimers(), or a stale debounce/throttle will fire a
    // duplicate stop afterwards.

    // handleSend: slice from `const handleSend` to its end.
    const handleSendStart = source.indexOf("const handleSend");
    expect(handleSendStart).toBeGreaterThan(-1);
    const handleSendBody = source.slice(handleSendStart, handleSendStart + 3000);
    expect(handleSendBody).toContain("setTyping(false);");
    expect(handleSendBody).toContain("resetTypingTimers()");

    // activeRoomId watcher body.
    const watchStart = source.indexOf("() => chatStore.activeRoomId");
    expect(watchStart).toBeGreaterThan(-1);
    const watchBody = source.slice(watchStart, watchStart + 2000);
    expect(watchBody).toMatch(/setTyping\(\s*false\s*,\s*oldId\s*\)/);
    expect(watchBody).toContain("resetTypingTimers()");

    // onBeforeUnmount body.
    const unmountStart = source.indexOf("onBeforeUnmount(()");
    expect(unmountStart).toBeGreaterThan(-1);
    const unmountBody = source.slice(unmountStart, unmountStart + 800);
    expect(unmountBody).toMatch(/setTyping\(\s*false\s*,\s*roomId\s*\)/);
    expect(unmountBody).toContain("resetTypingTimers()");
  });
});
