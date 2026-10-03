/**
 * Collapses bursts of calls into at most one call per `windowMs` (leading + trailing).
 * WebSocket pipelines emit dozens of events per job; refetching on each one
 * hammered the API with identical list/stat requests.
 */
export function coalesce(fn: () => void, windowMs = 2000): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return () => {
    const now = Date.now();
    const wait = last + windowMs - now;
    if (wait <= 0 && !timer) {
      last = now;
      fn();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      fn();
    }, Math.max(wait, 0));
  };
}
