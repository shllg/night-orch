import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupEnvFile } from '../../src/environment/env-file.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('setupEnvFile', () => {
  let tmpDir: string
  let worktreePath: string
  let repoPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-env-test-'))
    worktreePath = join(tmpDir, 'worktree')
    repoPath = join(tmpDir, 'repo')
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(repoPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies base .env', () => {
    writeFileSync(join(repoPath, '.env'), 'BASE_VAR=hello\n')

    setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: {},
      overrideFiles: [],
      usedPorts: [],
    })

    const content = readFileSync(join(worktreePath, '.env'), 'utf-8')
    expect(content).toContain('BASE_VAR=hello')
  })

  it('appends overrides in marked section', () => {
    writeFileSync(join(repoPath, '.env'), 'BASE=1\n')

    setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { MY_OVERRIDE: 'value' },
      overrideFiles: [],
      usedPorts: [],
    })

    const content = readFileSync(join(worktreePath, '.env'), 'utf-8')
    expect(content).toContain('# --- night-orch overrides ---')
    expect(content).toContain('MY_OVERRIDE=value')
    expect(content).toContain('# --- end night-orch overrides ---')
  })

  it('resolves {auto:min-max} port tokens', () => {
    writeFileSync(join(repoPath, '.env'), '')

    const result = setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { PORT: '{auto:5101-5199}' },
      overrideFiles: [],
      usedPorts: [5101, 5102],
    })

    expect(result.allocatedPort).toBe(5103)
    const content = readFileSync(join(worktreePath, '.env'), 'utf-8')
    expect(content).toContain('PORT=5103')
  })

  it('replaces existing marked section on rerun', () => {
    writeFileSync(join(repoPath, '.env'), 'BASE=1\n')

    // First run
    setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { A: '1' },
      overrideFiles: [],
      usedPorts: [],
    })

    // Second run with different overrides
    setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { B: '2' },
      overrideFiles: [],
      usedPorts: [],
    })

    const content = readFileSync(join(worktreePath, '.env'), 'utf-8')
    // Should not contain the old override
    expect(content).not.toContain('A=1')
    expect(content).toContain('B=2')
    // Only one set of markers
    expect(content.split('night-orch overrides').length - 1).toBe(2) // start + end
  })

  it('tracks allocated ports in usedPorts for same-pass uniqueness', () => {
    writeFileSync(join(repoPath, '.env'), '')
    const usedPorts: number[] = []
    const secondWorktreePath = join(tmpDir, 'worktree-2')
    mkdirSync(secondWorktreePath, { recursive: true })

    const first = setupEnvFile({
      worktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { PORT: '{auto:5101-5103}' },
      overrideFiles: [],
      usedPorts,
    })
    const second = setupEnvFile({
      worktreePath: secondWorktreePath,
      repoLocalPath: repoPath,
      copyFrom: '.env',
      overrides: { PORT: '{auto:5101-5103}' },
      overrideFiles: [],
      usedPorts,
    })

    expect(first.allocatedPort).toBe(5101)
    expect(second.allocatedPort).toBe(5102)
    expect(usedPorts).toEqual([5101, 5102])
  })
})
