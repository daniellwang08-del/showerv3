/**
 * Run async work over `items` with at most `limit` concurrent executions.
 * Invokes `onProgress(completed, total)` after each item finishes (success or failure).
 */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;

  let completed = 0;
  let nextIndex = 0;
  const cap = Math.min(Math.max(1, limit), total);

  const runNext = async (): Promise<void> => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= total) return;
      try {
        await worker(items[i], i);
      } finally {
        completed += 1;
        onProgress?.(completed, total);
      }
    }
  };

  await Promise.all(Array.from({ length: cap }, () => runNext()));
}
