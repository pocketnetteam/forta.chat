import { describe, it, expect, beforeEach } from "vitest";
import {
  registerUploadAbort,
  abortUpload,
  unregisterUploadAbort,
  isUploadAbortable,
} from "./upload-abort-registry";

describe("upload-abort-registry", () => {
  const clientId = "test-client-123";

  beforeEach(() => {
    unregisterUploadAbort(clientId);
  });

  it("registers and returns an AbortController", () => {
    const controller = registerUploadAbort(clientId);
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  it("isUploadAbortable returns true after register", () => {
    registerUploadAbort(clientId);
    expect(isUploadAbortable(clientId)).toBe(true);
  });

  it("isUploadAbortable returns false for unknown clientId", () => {
    expect(isUploadAbortable("unknown")).toBe(false);
  });

  it("abortUpload aborts the controller and removes it", () => {
    const controller = registerUploadAbort(clientId);
    const result = abortUpload(clientId);
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(isUploadAbortable(clientId)).toBe(false);
  });

  it("abortUpload returns false if nothing to abort", () => {
    expect(abortUpload("unknown")).toBe(false);
  });

  it("unregisterUploadAbort cleans up without aborting", () => {
    const controller = registerUploadAbort(clientId);
    unregisterUploadAbort(clientId);
    expect(controller.signal.aborted).toBe(false);
    expect(isUploadAbortable(clientId)).toBe(false);
  });

  it("re-registering aborts the previous controller (idempotent)", () => {
    const first = registerUploadAbort(clientId);
    const second = registerUploadAbort(clientId);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });
});
