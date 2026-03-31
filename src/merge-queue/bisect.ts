/**
 * Split a batch of PR numbers in half for bisection.
 * Returns two sub-arrays. The first half gets ceil(n/2) items.
 */
export function bisectBatch(prNumbers: number[]): [number[], number[]] {
  if (prNumbers.length <= 1) {
    throw new Error('Cannot bisect a batch of 0 or 1 PRs')
  }
  const mid = Math.ceil(prNumbers.length / 2)
  return [prNumbers.slice(0, mid), prNumbers.slice(mid)]
}

/**
 * Check if a batch has been narrowed down to a single culprit.
 */
export function isCulpritIdentified(prNumbers: number[]): boolean {
  return prNumbers.length === 1
}
