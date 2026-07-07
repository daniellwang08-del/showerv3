/** Coalesce identical in-flight async work (e.g. React StrictMode double-mount). */
const inflight = new Map<string, Promise<unknown>>();

export function requestOnce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
