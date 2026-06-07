import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, resolveConfigPath } from '../../src/config/loader.js'

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

  it('loadConfig rejects unknown workflow agent profile references', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: /tmp/repo
workflows:
  fast-trivial:
    agents:
      codex: codex-fast
    steps:
      - type: worker
        id: code
        role: coder
      - type: decide
        id: decide
        onIterate: code
`)

    expect(() => loadConfig(configPath)).toThrow('Workflow fast-trivial: agent "codex" references unknown worker profile "codex-fast"')
  })

  it('loadConfig accepts workflow agent profile references when profiles exist', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
  codex-fast:
    type: codex
    command: codex
repos:
  - repo: org/repo
    localPath: /tmp/repo
workflows:
  fast-trivial:
    agents:
      codex: codex-fast
    steps:
      - type: worker
        id: code
        role: coder
      - type: decide
        id: decide
        onIterate: code
`)

    const loaded = loadConfig(configPath)
    expect(loaded.workflows['fast-trivial']?.agents?.['codex']).toBe('codex-fast')
  })

  it('deep-merges per-repo .night-orch.yml with system config (project wins)', () => {
    const repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })

    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
  codex-default:
    type: codex
    command: codex
repos:
  - repo: org/repo
    localPath: ${repoDir}
    defaults:
      planner: codex
      coder: claude
      reviewer: claude
    environment:
      beforeRun:
        - command: pnpm typecheck
    workflow: standard
workflows:
  standard:
    steps:
      - type: worker
        id: code
        role: coder
      - type: decide
        id: decide
        onIterate: code
`)

    writeFileSync(join(repoDir, '.night-orch.yml'), `workflows:
  project-fast:
    steps:
      - type: worker
        id: code
        role: coder
      - type: decide
        id: decide
        onIterate: code
defaults:
  coder: codex
environment:
  beforeRun:
    - command: pnpm install
workflow: project-fast
`)

    const loaded = loadConfig(configPath)
    const repo = loaded.repos[0]

    expect(repo?.defaults.planner).toBe('codex')
    expect(repo?.defaults.coder).toBe('codex')
    expect(repo?.defaults.reviewer).toBe('claude')
    expect(repo?.workflow).toBe('project-fast')
    expect(repo?.environment?.beforeRun).toHaveLength(1)
    const beforeHook = repo?.environment?.beforeRun[0]
    expect(beforeHook && typeof beforeHook === 'object' && 'command' in beforeHook ? beforeHook.command : beforeHook).toBe('pnpm install')
    expect(loaded.workflows['project-fast']?.steps).toHaveLength(2)
  })

  it('merges project-local verificationProfiles into top-level config', () => {
    const repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })

    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  codex-default:
    type: codex
    command: codex
verificationProfiles:
  baseline:
    stages:
      - id: smoke
        commands:
          - pnpm typecheck
repos:
  - repo: org/repo
    localPath: ${repoDir}
    verificationProfile: baseline
`)

    writeFileSync(join(repoDir, '.night-orch.yml'), `verificationProfile: strict
verificationProfiles:
  strict:
    stages:
      - id: smoke
        commands:
          - pnpm lint
      - id: full
        commands:
          - pnpm test
        required: false
        onFailure: warn
`)

    const loaded = loadConfig(configPath)
    expect(loaded.repos[0]?.verificationProfile).toBe('strict')
    expect(loaded.verificationProfiles['baseline']?.stages).toHaveLength(1)
    expect(loaded.verificationProfiles['strict']?.stages).toHaveLength(2)
  })

  it('loads .night-orch.yaml when .night-orch.yml is not present', () => {
    const repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })

    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: ${repoDir}
    defaults:
      reviewer: claude
`)

    writeFileSync(join(repoDir, '.night-orch.yaml'), `defaults:
  reviewer: codex
`)

    const loaded = loadConfig(configPath)
    expect(loaded.repos[0]?.defaults.reviewer).toBe('codex')
  })

  it('rejects ambiguous per-repo config when both .yml and .yaml exist', () => {
    const repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })

    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: ${repoDir}
`)

    writeFileSync(join(repoDir, '.night-orch.yml'), 'defaults:\n  coder: codex\n')
    writeFileSync(join(repoDir, '.night-orch.yaml'), 'defaults:\n  coder: claude\n')

    expect(() => loadConfig(configPath)).toThrow('Multiple project config files found')
  })

  it('validates per-repo project config top-level keys', () => {
    const repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })

    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: ${repoDir}
`)

    writeFileSync(join(repoDir, '.night-orch.yml'), `repo: org/other
defaults:
  coder: codex
`)

    expect(() => loadConfig(configPath)).toThrow('Project config validation failed')
  })

  describe('MISE_TRUSTED_CONFIG_PATHS registration', () => {
    const originalTrusted = process.env['MISE_TRUSTED_CONFIG_PATHS']

    afterEach(() => {
      if (originalTrusted === undefined) delete process.env['MISE_TRUSTED_CONFIG_PATHS']
      else process.env['MISE_TRUSTED_CONFIG_PATHS'] = originalTrusted
    })

    function writeMinimalConfig(worktreeRoot: string): string {
      const configPath = join(tmpDir, 'config.yaml')
      writeFileSync(configPath, `version: 1
github:
  tokenEnv: GITHUB_TOKEN
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: /tmp/repo
storage:
  worktreeRoot: ${worktreeRoot}
`)
      return configPath
    }

    it('adds the expanded worktreeRoot to MISE_TRUSTED_CONFIG_PATHS', () => {
      delete process.env['MISE_TRUSTED_CONFIG_PATHS']
      const worktreeRoot = join(tmpDir, 'wt-root')
      loadConfig(writeMinimalConfig(worktreeRoot))
      expect(process.env['MISE_TRUSTED_CONFIG_PATHS']).toBe(worktreeRoot)
    })

    it('preserves existing MISE_TRUSTED_CONFIG_PATHS entries', () => {
      process.env['MISE_TRUSTED_CONFIG_PATHS'] = '/some/other/path'
      const worktreeRoot = join(tmpDir, 'wt-root')
      loadConfig(writeMinimalConfig(worktreeRoot))
      expect(process.env['MISE_TRUSTED_CONFIG_PATHS']).toBe(`/some/other/path:${worktreeRoot}`)
    })

    it('does not duplicate the worktreeRoot when loadConfig runs twice', () => {
      delete process.env['MISE_TRUSTED_CONFIG_PATHS']
      const worktreeRoot = join(tmpDir, 'wt-root')
      const configPath = writeMinimalConfig(worktreeRoot)
      loadConfig(configPath)
      loadConfig(configPath)
      expect(process.env['MISE_TRUSTED_CONFIG_PATHS']).toBe(worktreeRoot)
    })

    it('expands ~ in worktreeRoot before registering', () => {
      delete process.env['MISE_TRUSTED_CONFIG_PATHS']
      // HOME is already pointed at tmpDir/fake-home by the outer beforeEach
      loadConfig(writeMinimalConfig('~/wt-root'))
      expect(process.env['MISE_TRUSTED_CONFIG_PATHS']).toBe(join(tmpDir, 'fake-home', 'wt-root'))
    })
  })
})
