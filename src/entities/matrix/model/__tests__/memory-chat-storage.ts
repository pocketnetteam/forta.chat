/** In-memory stand-in for ChatStorage (IndexedDB) in pcrypto tests. Kept
 *  free of matrix-crypto imports so a vi.mock factory can load it without a
 *  circular module wait. */
export function createMemoryChatStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (key: string) => {
      if (!store.has(key)) throw new Error("Data does not exist");
      return store.get(key);
    },
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    clear: async (key: string) => {
      store.delete(key);
    },
  };
}
