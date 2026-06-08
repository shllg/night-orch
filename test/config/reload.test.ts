import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/loader.js'
import { tryReloadConfig } from '../../src/config/reload.js'

function makeConfig(pollIntervalSeconds: number, worktreeRoot: string): string {
  return `version: 1
github:
  tokenEnv: GITHUB_TOKEN
  pollIntervalSeconds: ${pollIntervalSeconds}
workerProfiles:
  claude-default:
    type: claude
    command: claude
repos:
  - repo: org/repo
    localPath: /tmp/repo
storage:
  worktreeRoot: ${worktreeRoot}
`
}

const INVALID = `version: 1
storage: not-an-object
`

describe('tryReloadConfig', () => {
  let tmp: string
  let configPath: string
  let worktreeRoot: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'night-orch-reload-cfg-'))
    configPath = join(tmp, 'config.yaml')
    worktreeRoot = join(tmp, 'wt-root')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns the new config when the file parses cleanly', () => {
    writeFileSync(configPath, makeConfig(60, worktreeRoot))
    const current = loadConfig(configPath)
    writeFileSync(configPath, makeConfig(300, worktreeRoot))

    const result = tryReloadConfig(configPath, current)

    expect(result.reloaded).toBe(true)
    expect(result.config.github.pollIntervalSeconds).toBe(300)
    expect(result.error).toBeUndefined()
  })

  it('keeps the current config and reports an error when the new file is invalid', () => {
    writeFileSync(configPath, makeConfig(60, worktreeRoot))
    const current = loadConfig(configPath)
    writeFileSync(configPath, INVALID)

    const result = tryReloadConfig(configPath, current)

    expect(result.reloaded).toBe(false)
    expect(result.config).toBe(current)
    expect(result.error).toBeDefined()
  })

  it('keeps the current config when the file disappears', () => {
    writeFileSync(configPath, makeConfig(60, worktreeRoot))
    const current = loadConfig(configPath)
    rmSync(configPath)

    const result = tryReloadConfig(configPath, current)

    expect(result.reloaded).toBe(false)
    expect(result.config).toBe(current)
    expect(result.error).toBeDefined()
  })
})
