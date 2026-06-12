import { describe, it, expect, beforeEach } from "vitest";
import {
  getVideoPosition,
  saveVideoPosition,
  clearVideoPosition,
  _resetVideoPositionCache,
} from "./video-position-store";

const KEY = "peertube://host/abc";

beforeEach(() => {
  localStorage.clear();
  _resetVideoPositionCache();
});

describe("video-position-store (WEE-82 / forta-bugs#964)", () => {
  it("returns 0 when no position is saved", () => {
    expect(getVideoPosition(KEY)).toBe(0);
  });

  it("saves and restores a mid-video position", () => {
    saveVideoPosition(KEY, 120, 600);
    expect(getVideoPosition(KEY)).toBe(120);
  });

  it("persists across cache resets (localStorage survives reload)", () => {
    saveVideoPosition(KEY, 90, 600);
    _resetVideoPositionCache();
    expect(getVideoPosition(KEY)).toBe(90);
  });

  it("drops near-start positions — restarting is fine", () => {
    saveVideoPosition(KEY, 3, 600);
    expect(getVideoPosition(KEY)).toBe(0);
  });

  it("clears the entry near the end — rewatch starts from 0", () => {
    saveVideoPosition(KEY, 120, 600);
    saveVideoPosition(KEY, 598, 600);
    expect(getVideoPosition(KEY)).toBe(0);
  });

  it("clearVideoPosition removes a saved entry", () => {
    saveVideoPosition(KEY, 120, 600);
    clearVideoPosition(KEY);
    expect(getVideoPosition(KEY)).toBe(0);
  });

  it("evicts oldest entries beyond the LRU cap", () => {
    for (let i = 0; i < 55; i++) {
      saveVideoPosition(`video-${i}`, 100 + i, 600);
    }
    // First entries were evicted, last ones survive
    expect(getVideoPosition("video-0")).toBe(0);
    expect(getVideoPosition("video-54")).toBe(154);
  });

  it("survives a broken localStorage payload", () => {
    localStorage.setItem("forta-video-positions", "{not json");
    _resetVideoPositionCache();
    expect(getVideoPosition(KEY)).toBe(0);
    saveVideoPosition(KEY, 60, 600);
    expect(getVideoPosition(KEY)).toBe(60);
  });
});
