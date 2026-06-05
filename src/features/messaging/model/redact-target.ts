/**
 * Pure guard for the "delete for all" redact path (WEE-66 / forta-bugs#773).
 *
 * A Matrix server event id always starts with "$". A message that hasn't been
 * confirmed by the server yet is identified only by its local `clientId` (a
 * UUID the server has never seen). Queuing a redact for a clientId silently
 * fails server-side — so we only enqueue a server-side redact for ids the
 * server actually knows; pending messages are deleted locally only.
 */
export function isServerEventId(id: string): boolean {
  return typeof id === "string" && id.startsWith("$");
}
