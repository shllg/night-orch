import { describe, it, expect } from 'vitest'
import { parseCommandSpec, parseCommandString, describeSpawnFailure } from '../../src/utils/command.js'

describe('parseCommandString', () => {
  it('parses simple commands', () => {
    expect(parseCommandString('pnpm test')).toEqual({
      binary: 'pnpm',
      args: ['test'],
    })
  })

  it('handles quoted arguments with spaces', () => {
    expect(parseCommandString('echo "hello world"')).toEqual({
      binary: 'echo',
      args: ['hello world'],
    })
  })

  it('handles single quotes', () => {
    expect(parseCommandString("node -e 'console.log(1)'")).toEqual({
      binary: 'node',
      args: ['-e', 'console.log(1)'],
    })
  })

  it('throws on unterminated quotes', () => {
    expect(() => parseCommandString('echo "oops')).toThrow('Unterminated')
  })
})

describe('parseCommandSpec', () => {
  it('passes through command arrays', () => {
    expect(parseCommandSpec(['pnpm', 'lint'])).toEqual({
      binary: 'pnpm',
      args: ['lint'],
    })
  })

  it('throws on empty command arrays', () => {
    expect(() => parseCommandSpec([])).toThrow('must contain at least one')
  })
})

describe('describeSpawnFailure', () => {
  it('names a missing path-form command with its resolved path and ENOENT', () => {
    const failure = describeSpawnFailure({ code: 'ENOENT', exitCode: undefined }, 'bin/ci-test-setup', '/wt')
    expect(failure).not.toBeNull()
    expect(failure!.code).toBe('ENOENT')
    expect(failure!.exitCode).toBe(127)
    expect(failure!.message).toContain('command not found')
    expect(failure!.message).toContain('bin/ci-test-setup')
    expect(failure!.message).toContain('/wt/bin/ci-test-setup')
    expect(failure!.message).toContain('[ENOENT]')
  })

  it('names a non-executable command with EACCES and exit 126', () => {
    const failure = describeSpawnFailure({ code: 'EACCES', exitCode: undefined }, './bin/setup', '/wt')
    expect(failure!.exitCode).toBe(126)
    expect(failure!.message).toContain('command not executable')
    expect(failure!.message).toContain('[EACCES]')
  })

  it('keeps an absolute path verbatim', () => {
    const failure = describeSpawnFailure({ code: 'ENOENT' }, '/opt/tool/run', '/wt')
    expect(failure!.message).toContain('/opt/tool/run (/opt/tool/run)')
  })

  it('omits a resolved path (and false "not on PATH") for bare commands', () => {
    const failure = describeSpawnFailure({ code: 'ENOENT' }, 'pnpm', '/wt')
    expect(failure!.message).toBe('command not found in worktree: pnpm [ENOENT]')
    expect(failure!.message).not.toContain('not on PATH')
  })

  it('falls back to a generic reason + exit 126 for an unlisted errno', () => {
    const failure = describeSpawnFailure({ code: 'ELOOP' }, 'bin/x', '/wt')
    expect(failure!.exitCode).toBe(126)
    expect(failure!.message).toContain('command could not be executed')
    expect(failure!.message).toContain('[ELOOP]')
  })

  it('returns null for normal non-zero exits (no spawn errno)', () => {
    expect(describeSpawnFailure({ exitCode: 3 }, 'pnpm', '/wt')).toBeNull()
  })

  it('returns null for timeout/signal kills (exitCode undefined but no code)', () => {
    expect(describeSpawnFailure({ exitCode: undefined, timedOut: true }, 'pnpm', '/wt')).toBeNull()
    expect(describeSpawnFailure({ exitCode: undefined, signal: 'SIGKILL' }, 'pnpm', '/wt')).toBeNull()
  })

  it('returns null for non-object inputs', () => {
    expect(describeSpawnFailure(undefined, 'pnpm', '/wt')).toBeNull()
    expect(describeSpawnFailure('boom', 'pnpm', '/wt')).toBeNull()
  })
})
