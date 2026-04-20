/** Round-robin proxy rotator with "sticky last-good" behavior.
 *
 *  Why: Registration in Forta Chat goes through pocketnet proxies. When one
 *  proxy is down, the original code pinned regProxyId to that dead node and
 *  every subsequent call (getCaptcha, requestFreeRegistration, checkUnspents)
 *  silently timed out — users saw "registration hangs 12 hours".
 *
 *  Contract:
 *  - `call(fn)` tries the current proxy first; on error, advances to the next
 *    and retries. After one full pass without success, throws.
 *  - On success, the current proxy becomes the new "head" — subsequent calls
 *    start from the last-good proxy to avoid re-hitting a dead node.
 *  - `reset()` forces the next call to start from index 0.
 *  - `current()` returns the current head without mutating state.
 */
export class ProxyRotator<T = unknown> {
  private head = 0;

  constructor(private readonly proxies: readonly T[]) {}

  current(): T {
    if (this.proxies.length === 0) {
      throw new Error("ProxyRotator: empty proxy list");
    }
    return this.proxies[this.head];
  }

  reset(): void {
    this.head = 0;
  }

  async call<R>(fn: (proxy: T) => Promise<R>): Promise<R> {
    if (this.proxies.length === 0) {
      throw new Error("ProxyRotator: empty proxy list");
    }

    const errors: unknown[] = [];
    for (let attempt = 0; attempt < this.proxies.length; attempt++) {
      const idx = (this.head + attempt) % this.proxies.length;
      const proxy = this.proxies[idx];
      try {
        const result = await fn(proxy);
        // Sticky last-good — next call starts from the proxy that just worked.
        this.head = idx;
        return result;
      } catch (err) {
        errors.push(err);
      }
    }
    throw new Error(
      `All registration proxies failed (${errors.length} attempts). Last error: ${String(
        errors[errors.length - 1],
      )}`,
    );
  }
}
