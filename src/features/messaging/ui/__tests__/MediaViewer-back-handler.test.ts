import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "../MediaViewer.vue"),
  "utf-8",
);

/**
 * WEE-51 / forta-bugs#805 — Tapping Android back inside a fullscreen photo
 * viewer used to kick the user out of the chat instead of just closing the
 * viewer. Two root causes:
 *   1. The viewer registered its back-handler under a fixed id, so two
 *      mounted instances (MessageList + ChatInfoGallery on the same screen)
 *      silently overwrote each other.
 *   2. When the WebView opened a <video> in native fullscreen, the first
 *      back press closed the viewer (and chat) while the system was still
 *      in fullscreen mode, instead of exiting fullscreen first.
 *
 * These are source-level invariants because mounting MediaViewer needs the
 * full chat-store stack — too heavy for a focused regression test.
 */
describe("MediaViewer back-handler (WEE-51)", () => {
  it("registers a per-instance handler id, not a shared 'media-viewer' literal", () => {
    // Old code: useAndroidBackHandler("media-viewer", 100, ...)
    // New code: const backHandlerId = `media-viewer-${++counter}`
    expect(source).not.toMatch(/useAndroidBackHandler\(\s*"media-viewer"/);
    expect(source).toMatch(/media-viewer-\$\{[^}]+\}/);
    expect(source).toMatch(/useAndroidBackHandler\(\s*backHandlerId/);
  });

  it("module-scopes the instance counter (so it survives across mounts)", () => {
    // The counter MUST live outside `<script setup>`; otherwise it resets to
    // 0 on every component setup and collides again.
    expect(source).toMatch(/<script lang="ts">[\s\S]*let mediaViewerInstanceCounter[\s\S]*<\/script>/);
  });

  it("exits native <video> fullscreen before closing the viewer on back", () => {
    expect(source).toMatch(/document\.fullscreenElement/);
    expect(source).toMatch(/exitFullscreen\?\.\(\)/);
  });

  it("still emits close when not in fullscreen", () => {
    // The handler must end with the existing emit("close") path so non-video
    // images keep closing as before.
    expect(source).toMatch(/emit\("close"\);\s*return true;\s*\}\);/);
  });
});
