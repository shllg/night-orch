import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
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

  it('loads local config.yaml by default', () => {
    const expected = join(tmpDir, 'config.yaml')
    writeFileSync(expected, 'version: 1\nrepos: []\n')
    expect(resolveConfigPath()).toBe(expected)
  })

  it('prefers local config.yaml over both home config locations', () => {
    const local = join(tmpDir, 'config.yaml')
    const homeDirNew = join(tmpDir, 'fake-home', '.night-orch')
    const homeNew = join(homeDirNew, 'config.yaml')
    const homeDirLegacy = join(tmpDir, 'fake-home', '.config', 'night-orch')
    const homeLegacy = join(homeDirLegacy, 'config.yaml')
    writeFileSync(local, 'version: 1\nrepos: []\n')
    mkdirSync(homeDirNew, { recursive: true })
    writeFileSync(homeNew, 'version: 1\nrepos: []\n', { flag: 'w' })
    mkdirSync(homeDirLegacy, { recursive: true })
    writeFileSync(homeLegacy, 'version: 1\nrepos: []\n', { flag: 'w' })
    expect(resolveConfigPath()).toBe(local)
  })

  it('falls back to ~/.night-orch/config.yaml before legacy ~/.config path', () => {
    const homeDirNew = join(tmpDir, 'fake-home', '.night-orch')
    const homeNew = join(homeDirNew, 'config.yaml')
    const homeDirLegacy = join(tmpDir, 'fake-home', '.config', 'night-orch')
    const homeLegacy = join(homeDirLegacy, 'config.yaml')
    mkdirSync(homeDirNew, { recursive: true })
    writeFileSync(homeNew, 'version: 1\nrepos: []\n', { flag: 'w' })
    mkdirSync(homeDirLegacy, { recursive: true })
    writeFileSync(homeLegacy, 'version: 1\nrepos: []\n', { flag: 'w' })
    expect(resolveConfigPath()).toBe(homeNew)
  })

  it('falls back to legacy ~/.config/night-orch/config.yaml when ~/.night-orch is missing', () => {
    const homeDirLegacy = join(tmpDir, 'fake-home', '.config', 'night-orch')
    const homeLegacy = join(homeDirLegacy, 'config.yaml')
    mkdirSync(homeDirLegacy, { recursive: true })
    writeFileSync(homeLegacy, 'version: 1\nrepos: []\n', { flag: 'w' })
    expect(resolveConfigPath()).toBe(homeLegacy)
  })

  it('loads workspace config when explicitly trusted', () => {
    const expected = join(tmpDir, '.night-orch.yaml')
    writeFileSync(expected, 'version: 1\nrepos: []\n')
    expect(resolveConfigPath(undefined, { trustWorkspace: true })).toBe(expected)
  })
})
