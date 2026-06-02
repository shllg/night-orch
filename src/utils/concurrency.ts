/**
 * Map items to async results while bounding concurrent invocations.
 *
 * Preserves input order in the result array. Rejections propagate through
 * Promise.all once the currently running workers settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(items.length)
  if (items.length === 0) return results

  const workerCount = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return

      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  })

  await Promise.all(workers)
  return results
}
