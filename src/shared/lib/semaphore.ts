/**
 * Counting semaphore — ограничивает число одновременно выполняемых
 * асинхронных операций.
 *
 * Зачем: на слабых Android одновременный `fetch` + decrypt нескольких
 * полноразмерных фото в личном чате забивает сетевой канал и сатурирует CPU,
 * из-за чего последняя картинка ждёт декрипт всех предыдущих, а UI фризит.
 * Семафор держит не более `max` операций в полёте, остальные ждут в FIFO-
 * очереди (WEE-71, H2 concurrency-pool).
 *
 * Контракт: каждый успешный `acquire()` ОБЯЗАН быть закрыт ровно одним
 * `release()` (обычно в `finally`). Лишние `release()` без захвата
 * игнорируются, чтобы случайный двойной вызов не «раздул» пул выше `max`.
 */
export interface Semaphore {
  /** Захватить разрешение. Резолвится сразу при свободном слоте, иначе
   *  встаёт в FIFO-очередь и резолвится при следующем `release()`. */
  acquire(): Promise<void>;
  /** Освободить разрешение: пропускает первого ожидающего из очереди, а если
   *  очередь пуста — уменьшает счётчик активных. */
  release(): void;
  /** Число операций в полёте (для тестов/диагностики). */
  readonly active: number;
  /** Число ожидающих в очереди (для тестов/диагностики). */
  readonly pending: number;
}

export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`createSemaphore: max must be a positive integer, got ${String(max)}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  };

  const release = (): void => {
    const next = queue.shift();
    if (next) {
      // Слот передаётся следующему ожидающему: `active` не меняется — место
      // освободившейся операции занимает разбуженный из очереди.
      next();
      return;
    }
    // Очередь пуста — реально освобождаем слот. Guard от лишнего release().
    if (active > 0) active--;
  };

  return {
    acquire,
    release,
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}
