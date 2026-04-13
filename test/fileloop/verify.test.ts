import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileLoopConfig } from '../../src/config/schema.js'
import { verifyAll, verifyFile } from '../../src/fileloop/verify.js'

const config: FileLoopConfig = {
  enabled: true,
  maxDurationMinutes: 60,
  maxIterations: 100,
  minIntervalSecondsBetweenFiles: 5,
  perIterationTimeoutSeconds: 30,
  maxCostUsd: 5,
  maxFileLines: 100,
  includeGlobs: ['**/*.{ts,md}'],
  excludeGlobs: ['**/*.snap', 'loop.md'],
  reviewerProfileKey: 'cheap',
  branchNameTemplate: 'orch/file-loop/{repoSlug}/{yyyyMmDd}',
  loopMdPath: 'loop.md',
  commitPrefix: '[FILE-LOOP]',
  perEditVerify: { enabled: true, commands: ['node ok.js'], timeoutSeconds: 5 },
  finalizeVerify: { enabled: true, commands: ['node fail.js'], timeoutSeconds: 5, onFailure: 'draft-pr' },
}

describe('file-loop verify', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-fileloop-verify-'))
    writeFileSync(join(tmpDir, 'ok.js'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(tmpDir, 'fail.js'), 'process.exit(1)\n', 'utf8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes successful per-file verification', async () => {
    const result = await verifyFile(tmpDir, 'src/app.ts', config)
    expect(result.passed).toBe(true)
    expect(result.results).toHaveLength(1)
  })

  it('reports failed finalize verification', async () => {
    const result = await verifyAll(tmpDir, config)
    expect(result.passed).toBe(false)
    expect(result.results[0]?.exitCode).toBe(1)
  })
})
