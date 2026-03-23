/**
 * PromisePool — дедупликатор in-flight запросов.
 *
 * N одновременных вызовов для одного ключа порождают ровно 1 выполнение fn(),
 * остальные получают тот же Promise. После resolve/reject ключ освобождается.
 */
export class PromisePool<T = void> {
  private inflight = new Map<string, Promise<T>>();

  /**
   * Если запрос для `key` уже in-flight — возвращает тот же Promise.
   * Иначе выполняет fn() и сохраняет Promise до завершения.
   */
  dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Пакетный вариант: из массива ключей выделяет те, что НЕ in-flight,
   * вызывает batchFn(uncached) один раз, и регистрирует shared promise
   * для всех ключей СИНХРОННО (до await) — закрывая race window.
   *
   * Возвращает массив ключей, для которых был реально вызван batchFn.
   */
  async dedupeBatch(
    keys: string[],
    batchFn: (uncached: string[]) => Promise<T>,
  ): Promise<string[]> {
    const waitFor: Promise<T>[] = [];
    const uncached: string[] = [];

    for (const key of keys) {
      const existing = this.inflight.get(key);
      if (existing) {
        waitFor.push(existing);
      } else {
        uncached.push(key);
      }
    }

    if (uncached.length === 0) {
      if (waitFor.length > 0) await Promise.all(waitFor);
      return [];
    }

    // Один shared promise для всего батча
    const batchPromise = batchFn(uncached).finally(() => {
      for (const key of uncached) this.inflight.delete(key);
    });

    // Регистрируем СРАЗУ синхронно — до любого await
    for (const key of uncached) {
      this.inflight.set(key, batchPromise);
    }

    await Promise.all([batchPromise, ...waitFor]);
    return uncached;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  get size(): number {
    return this.inflight.size;
  }
}
