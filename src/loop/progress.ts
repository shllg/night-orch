import { createHash } from 'node:crypto'
import type { VerifyResult } from '../workers/types.js'

export interface IterationSnapshot {
  iteration: number
  verifyHash: string
}

/**
 * Compute a deterministic hash of verify results, stripping non-deterministic
 * content (timestamps, ANSI codes, temp paths, execution times) so that
 * identical failure patterns produce the same hash even across runs.
 */
export function hashVerifyResults(results: readonly VerifyResult[]): string {
  const normalized = results.map((r) => ({
    passed: r.passed,
    stdout: sanitizeVerifyOutput(r.stdout),
    stderr: sanitizeVerifyOutput(r.stderr),
  }))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

/**
 * Assess whether the loop is making progress by comparing the current
 * verify hash against prior iteration snapshots.
 *
 * Returns 'stuck' if the same verify output appeared in the previous
 * iteration (identical failures 2x in a row). Returns 'progressing'
 * otherwise.
 */
export function assessProgress(
  currentVerifyHash: string,
  priorSnapshots: readonly IterationSnapshot[],
): { status: 'progressing' | 'stuck'; reason: string } {
  if (priorSnapshots.length === 0) {
    return { status: 'progressing', reason: 'First iteration — no prior data' }
  }

  const lastSnapshot = priorSnapshots[priorSnapshots.length - 1]
  if (!lastSnapshot) {
    return { status: 'progressing', reason: 'No prior snapshot available' }
  }

  if (lastSnapshot.verifyHash === currentVerifyHash) {
    return {
      status: 'stuck',
      reason: `Identical verify output in iterations ${lastSnapshot.iteration} and current — loop is not making progress`,
    }
  }

  return { status: 'progressing', reason: 'Verify output differs from previous iteration' }
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.Z+:-]*/g
const DURATION_RE = /\b\d+(\.\d+)?\s*(ms|s|sec|seconds|minutes|min|m)\b/gi
const TEMP_PATH_RE = /\/tmp\/[^\s]+/g

function sanitizeVerifyOutput(output: string): string {
  return output
    .replace(ANSI_RE, '')
    .replace(TIMESTAMP_RE, '<TIME>')
    .replace(DURATION_RE, '<DUR>')
    .replace(TEMP_PATH_RE, '<TMP>')
    .replace(/\s+/g, ' ')
    .trim()
}
