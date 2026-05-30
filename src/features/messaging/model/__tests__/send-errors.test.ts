import { describe, it, expect, beforeEach } from "vitest";
import { SendError, classifyMicError, sendErrorI18nKey } from "../send-errors";
import {
  reportSendError,
  clearSendError,
  useSendErrorBus,
  __resetSendErrorBusForTests,
} from "../send-error-bus";

describe("SendError factory", () => {
  it("retains kind, message, and retryable flag", () => {
    const err = new SendError("uploadFailed", "boom", { fileName: "x.png" });
    expect(err.kind).toBe("uploadFailed");
    expect(err.message).toBe("boom");
    expect(err.context.fileName).toBe("x.png");
    expect(err.retryable).toBe(true);
  });

  it("supports non-retryable errors", () => {
    const err = new SendError("fileTooLarge", "too big", {}, false);
    expect(err.retryable).toBe(false);
  });
});

describe("classifyMicError", () => {
  it("maps NotAllowedError to micDenied", () => {
    const native = new Error("Permission denied");
    native.name = "NotAllowedError";
    const classified = classifyMicError(native);
    expect(classified.kind).toBe("micDenied");
    expect(classified.context.kind).toBe("audio");
  });

  it("maps PermissionDeniedError to micDenied", () => {
    const native = new Error("denied");
    native.name = "PermissionDeniedError";
    expect(classifyMicError(native).kind).toBe("micDenied");
  });

  it("maps NotFoundError to micDenied (no usable mic)", () => {
    const native = new Error("no device");
    native.name = "NotFoundError";
    expect(classifyMicError(native).kind).toBe("micDenied");
  });

  it("maps unknown errors to 'unknown'", () => {
    expect(classifyMicError(new Error("random")).kind).toBe("unknown");
  });

  it("classifies non-Error throws safely", () => {
    expect(classifyMicError("boom").kind).toBe("unknown");
    expect(classifyMicError(undefined).kind).toBe("unknown");
  });

  it("falls back on message keyword 'permission' even without name", () => {
    expect(classifyMicError(new Error("Permission revoked at runtime")).kind).toBe("micDenied");
  });
});

describe("sendErrorI18nKey", () => {
  it("builds a flat i18n key per kind", () => {
    expect(sendErrorI18nKey("micDenied")).toBe("errors.send.micDenied");
    expect(sendErrorI18nKey("uploadFailed")).toBe("errors.send.uploadFailed");
  });
});

describe("send-error bus", () => {
  beforeEach(() => __resetSendErrorBusForTests());

  it("exposes null when no error is reported", () => {
    const { error } = useSendErrorBus();
    expect(error.value).toBeNull();
  });

  it("publishes a reported error to subscribers", () => {
    const { error } = useSendErrorBus();
    reportSendError(new SendError("uploadFailed", "x"));
    expect(error.value?.kind).toBe("uploadFailed");
    expect(error.value?.retryable).toBe(true);
  });

  it("last error wins — replaces older errors", () => {
    const { error } = useSendErrorBus();
    reportSendError(new SendError("uploadFailed", "first"));
    const firstId = error.value!.id;
    reportSendError(new SendError("micDenied", "second"));
    expect(error.value?.kind).toBe("micDenied");
    expect(error.value!.id).not.toBe(firstId);
  });

  it("clear() with matching id removes the active error", () => {
    const { error } = useSendErrorBus();
    const entry = reportSendError(new SendError("uploadFailed", "x"));
    clearSendError(entry.id);
    expect(error.value).toBeNull();
  });

  it("clear() with stale id is a no-op", () => {
    const { error } = useSendErrorBus();
    reportSendError(new SendError("uploadFailed", "x"));
    clearSendError(9999);
    expect(error.value).not.toBeNull();
  });

  it("clear() without id removes the active error", () => {
    const { error } = useSendErrorBus();
    reportSendError(new SendError("uploadFailed", "x"));
    clearSendError();
    expect(error.value).toBeNull();
  });

  it("wraps non-SendError throws into a SendError with kind 'unknown'", () => {
    const { error } = useSendErrorBus();
    reportSendError(new Error("native boom"));
    expect(error.value?.kind).toBe("unknown");
    expect(error.value?.message).toBe("native boom");
  });

  it("stores retry callback for the banner to invoke", async () => {
    const { error } = useSendErrorBus();
    let called = false;
    reportSendError(new SendError("uploadFailed", "x"), () => {
      called = true;
    });
    await error.value!.retry?.();
    expect(called).toBe(true);
  });
});
