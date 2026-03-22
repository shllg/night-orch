import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfigPath } from '../../src/config/loader.js'

describe('resolveConfigPath', () => {
  const originalCwd = process.cwd()
  const originalHome = process.env['HOME']
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-loader-test-'))
    process.chdir(tmpDir)
    process.env['HOME'] = join(tmpDir, 'fake-home')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalHome) process.env['HOME'] = originalHome
    else delete process.env['HOME']
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not trust workspace config by default', () => {
    writeFileSync(join(tmpDir, '.night-orch.yaml'), 'version: 1\nrepos: []\n')
    expect(() => resolveConfigPath()).toThrow('trust-workspace')
  })

  it('loads workspace config when explicitly trusted', () => {
    const expected = join(tmpDir, '.night-orch.yaml')
    writeFileSync(expected, 'version: 1\nrepos: []\n')
    expect(resolveConfigPath(undefined, { trustWorkspace: true })).toBe(expected)
  })
})
