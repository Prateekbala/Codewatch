export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      results[index] = await task(items[index] as T, index);
    }
  };

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
};
