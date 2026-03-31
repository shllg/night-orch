import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectProjectType } from '../../../src/cli/init/detector.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('detectProjectType', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'detector-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('detects Node.js project', async () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}')
    const result = await detectProjectType(tmpDir)
    expect(result.type).toBe('node')
    expect(result.verifyCommands).toContain('pnpm test')
  })

  it('detects Rust project', async () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '')
    const result = await detectProjectType(tmpDir)
    expect(result.type).toBe('rust')
  })

  it('detects Go project', async () => {
    writeFileSync(join(tmpDir, 'go.mod'), '')
    const result = await detectProjectType(tmpDir)
    expect(result.type).toBe('go')
  })

  it('detects Python project', async () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), '')
    const result = await detectProjectType(tmpDir)
    expect(result.type).toBe('python')
  })

  it('returns unknown for empty directory', async () => {
    const result = await detectProjectType(tmpDir)
    expect(result.type).toBe('unknown')
    expect(result.verifyCommands).toEqual([])
  })

  it('detects main branch from git HEAD', async () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true })
    writeFileSync(join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(tmpDir, 'package.json'), '{}')
    const result = await detectProjectType(tmpDir)
    expect(result.baseBranch).toBe('main')
  })

  it('detects master branch from git HEAD', async () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true })
    writeFileSync(join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/master\n')
    writeFileSync(join(tmpDir, 'package.json'), '{}')
    const result = await detectProjectType(tmpDir)
    expect(result.baseBranch).toBe('master')
  })
})
