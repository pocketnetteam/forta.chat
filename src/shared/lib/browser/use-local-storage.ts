import { APP_NAME } from "@/shared/config";

interface UseLocalStorage<T> {
  setLSValue: (value: T) => void;
  value: T;
}

/**
 * A value kept in localStorage under the app's prefix.
 *
 * Reading and writing never throw: storage can be unavailable (private mode,
 * blocked site data, a full quota) or hold a value that is not JSON, and an
 * exception here used to take down the store that asked for it or drop a theme
 * setting mid-call (audit W2A-02). An unreadable value falls back to
 * `initialValue`; a failed write is logged and the in-memory state carries on.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue?: T
): UseLocalStorage<T> {
  const keyLS = `${APP_NAME}:${key}`;

  let value = initialValue as T;
  try {
    const valueLS = window.localStorage.getItem(keyLS);
    if (valueLS) value = JSON.parse(valueLS) as T;
  } catch (e) {
    console.warn(`[storage] could not read ${keyLS}:`, e);
  }

  function setLSValue(next: T): void {
    try {
      window.localStorage.setItem(keyLS, JSON.stringify(next));
    } catch (e) {
      console.warn(`[storage] could not save ${keyLS}:`, e);
    }
  }

  return { setLSValue, value };
}
