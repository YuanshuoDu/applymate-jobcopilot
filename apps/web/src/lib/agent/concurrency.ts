/** Bounded parallelism for independent job work; preserves one program-owned concurrency ceiling. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await work(items[index]!, index)
    }
  }))
}
