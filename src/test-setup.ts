// Global test setup for Vitest
import { afterEach, vi } from "vitest";

// Many suites use vi.useFakeTimers(); if a test forgets to restore, later
// suites (notably call-service permission flows) hang until timeout.
afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
