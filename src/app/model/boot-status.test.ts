import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bootStatus } from "./boot-status";

describe("bootStatus", () => {
  beforeEach(() => {
    bootStatus.reset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in booting state with scripts step", () => {
    expect(bootStatus.state.value).toBe("booting");
    expect(bootStatus.currentStep.value).toBe("scripts");
    expect(bootStatus.error.value).toBeNull();
    expect(bootStatus.errorKind.value).toBeNull();
  });

  it("advances steps", () => {
    bootStatus.setStep("tor");
    expect(bootStatus.currentStep.value).toBe("tor");

    bootStatus.setStep("matrix");
    expect(bootStatus.currentStep.value).toBe("matrix");
  });

  it("transitions to ready", () => {
    bootStatus.setStep("auth");
    bootStatus.setReady();
    expect(bootStatus.state.value).toBe("ready");
    expect(bootStatus.currentStep.value).toBe("ready");
  });

  it("transitions to error with default generic kind", () => {
    bootStatus.setStep("matrix");
    bootStatus.setError("Connection refused");
    expect(bootStatus.state.value).toBe("error");
    expect(bootStatus.error.value).toBe("Connection refused");
    expect(bootStatus.errorKind.value).toBe("generic");
  });

  it("preserves typed error kind", () => {
    bootStatus.setStep("matrix");
    bootStatus.setError("homeserver 503", "matrix-unreachable");
    expect(bootStatus.errorKind.value).toBe("matrix-unreachable");
    expect(bootStatus.error.value).toBe("homeserver 503");
  });

  it("ignores setStep after ready", () => {
    bootStatus.setReady();
    bootStatus.setStep("matrix");
    expect(bootStatus.currentStep.value).toBe("ready");
  });

  it("ignores setReady after error", () => {
    bootStatus.setError("fail");
    bootStatus.setReady();
    expect(bootStatus.state.value).toBe("error");
  });

  it("ignores subsequent setError calls (does not overwrite kind or message)", () => {
    bootStatus.setError("matrix offline", "matrix-unreachable");
    bootStatus.setError("something else", "generic");
    expect(bootStatus.error.value).toBe("matrix offline");
    expect(bootStatus.errorKind.value).toBe("matrix-unreachable");
  });

  it("reset clears error kind and message", () => {
    bootStatus.setStep("matrix");
    bootStatus.setError("fail", "matrix-unreachable");
    bootStatus.reset();
    expect(bootStatus.state.value).toBe("booting");
    expect(bootStatus.currentStep.value).toBe("scripts");
    expect(bootStatus.error.value).toBeNull();
    expect(bootStatus.errorKind.value).toBeNull();
  });
});
