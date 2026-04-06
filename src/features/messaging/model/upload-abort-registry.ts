/**
 * Registry of AbortControllers for in-flight media uploads.
 * Keyed by clientId (the idempotency key for each message).
 */
const controllers = new Map<string, AbortController>();

/** Register an AbortController for an upload. Aborts any existing one for this clientId. */
export function registerUploadAbort(clientId: string): AbortController {
  const existing = controllers.get(clientId);
  if (existing) existing.abort();

  const controller = new AbortController();
  controllers.set(clientId, controller);
  return controller;
}

/** Abort an in-flight upload. Returns true if there was something to abort. */
export function abortUpload(clientId: string): boolean {
  const controller = controllers.get(clientId);
  if (!controller) return false;
  controller.abort();
  controllers.delete(clientId);
  return true;
}

/** Cleanup after upload completes (success or failure). Does not abort. */
export function unregisterUploadAbort(clientId: string): void {
  controllers.delete(clientId);
}

/** Check if an upload is currently in-flight and abortable. */
export function isUploadAbortable(clientId: string): boolean {
  return controllers.has(clientId);
}
