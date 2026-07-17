/**
 * Run an async mapper over items in parallel batches of `size`.
 *
 * Items inside a batch run concurrently (Promise.all); batches run
 * sequentially with an optional `betweenBatches` hook (e.g. yieldToMain)
 * so long pipelines don't starve rendering/input on the main thread.
 *
 * The mapper is expected to handle its own errors — a rejection inside a
 * batch rejects the whole call (Promise.all semantics).
 */
export async function runInBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
  betweenBatches?: () => Promise<void>,
): Promise<R[]> {
  if (size < 1) throw new Error("runInBatches: size must be >= 1");

  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const settled = await Promise.all(batch.map(fn));
    results.push(...settled);
    if (betweenBatches && i + size < items.length) {
      await betweenBatches();
    }
  }
  return results;
}
