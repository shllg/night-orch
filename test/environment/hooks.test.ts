import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { execa } from 'execa'
import { logger } from '../../src/utils/logger.js'
import { runRunHooks } from '../../src/environment/hooks.js'
import type { RunTokens } from '../../src/environment/tokens.js'

const mockExeca = vi.mocked(execa)
const mockLoggerWarn = vi.mocked(logger.warn)
const tokens: RunTokens = { issue: 1, run: 'r1', port: 5400, project: 'proj-1-r1' }
const namedTokens: RunTokens = {
  issue: 1, run: 'r1', port: 5460,
  ports: { postgres: 5460, redis: 6460 }, project: 'proj-1-r1',
}

describe('runRunHooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('substitutes tokens and runs hooks in order', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks('/wt', [['docker', 'compose', '-p', '{project}', 'up']], tokens, 'fail-fast')

    expect(mockExeca).toHaveBeenCalledWith('docker', ['compose', '-p', 'proj-1-r1', 'up'], expect.any(Object))
  })

  it('fail-fast: throws when a hook exits non-zero', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' } as never)

    await expect(runRunHooks('/wt', [['docker', 'up']], tokens, 'fail-fast')).rejects.toThrow()
  })

  it('attempt-all: runs every hook even when one fails and never throws', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'down1 failed' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [['docker', 'down'], ['rm', 'db']], tokens, 'attempt-all'),
    ).resolves.toBeUndefined()

    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('rm', ['db'], expect.any(Object))
  })

  it('applies failure hints to the thrown message on fail-fast', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'role "app_user" does not exist' } as never)

    await expect(
      runRunHooks(
        '/wt',
        [{ command: ['bundle', 'db:prepare'], failureHints: [{ contains: 'app_user', message: 'Create the role.' }] }],
        tokens,
        'fail-fast',
      ),
    ).rejects.toThrow('Create the role.')
  })

  it('token-substitutes hook env (incl {port:NAME}) and passes it to execa', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks(
      '/wt',
      [{ command: ['docker', 'compose', 'up'], env: { DAILYWERK_PG_PORT: '{port:postgres}', REDIS_URL: 'redis://localhost:{port:redis}' } }],
      namedTokens,
      'fail-fast',
    )

    const opts = mockExeca.mock.calls[0]![2] as { env: Record<string, string> }
    expect(opts.env['DAILYWERK_PG_PORT']).toBe('5460')
    expect(opts.env['REDIS_URL']).toBe('redis://localhost:6460')
  })

  it('bypasses the secret blacklist: a *PASSWORD* env key reaches the child verbatim', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks(
      '/wt',
      [{ command: ['docker', 'up'], env: { DAILYWERK_PG_PASSWORD: 'localdev' } }],
      tokens,
      'fail-fast',
    )

    const opts = mockExeca.mock.calls[0]![2] as { env: Record<string, string> }
    expect(opts.env['DAILYWERK_PG_PASSWORD']).toBe('localdev')
  })

  it('fail-fast: throws on an unresolved {port:NAME} in a hook env value', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [{ command: ['x'], env: { URL: 'x:{port:rustfs}' } }], namedTokens, 'fail-fast'),
    ).rejects.toThrow(/\{port:rustfs\}/)
    expect(mockExeca).not.toHaveBeenCalled()
  })

  it('never logs hook env values', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'fail' } as never)

    await runRunHooks('/wt', [{ command: ['x'], env: { SECRETish: 'do-not-log-me' } }], tokens, 'attempt-all')

    const logged = JSON.stringify(mockLoggerWarn.mock.calls)
    expect(logged).not.toContain('do-not-log-me')
  })

  // execa with reject:false RESOLVES spawn errors (missing/non-executable
  // binary) with exitCode undefined + a `code` errno — never a clean throw.
  it('fail-fast: a missing hook names the file + ENOENT, never bare "Exit code: undefined"', async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined, code: 'ENOENT', stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [['bin/ci-test-setup']], tokens, 'fail-fast'),
    ).rejects.toThrow(/command not found in worktree: bin\/ci-test-setup .*\/wt\/bin\/ci-test-setup.* \[ENOENT\]/)

    await expect(
      runRunHooks('/wt', [['bin/ci-test-setup']], tokens, 'fail-fast'),
    ).rejects.not.toThrow(/Exit code: undefined/)
  })

  it('fail-fast: a non-executable hook names the file + EACCES', async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined, code: 'EACCES', stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [['./scripts/up.sh']], tokens, 'fail-fast'),
    ).rejects.toThrow(/command not executable in worktree: \.\/scripts\/up\.sh .*\[EACCES\]/)
  })

  it('threads explicit timeoutSeconds into execa as milliseconds', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks(
      '/wt',
      [{ command: ['bin/heavy-bootstrap'], timeoutSeconds: 600 }],
      tokens,
      'fail-fast',
    )

    const opts = mockExeca.mock.calls[0]![2] as { timeout: number }
    expect(opts.timeout).toBe(600_000)
  })

  it('defaults to the 5-minute timeout when timeoutSeconds is omitted', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks('/wt', [['docker', 'compose', 'up']], tokens, 'fail-fast')

    const opts = mockExeca.mock.calls[0]![2] as { timeout: number }
    expect(opts.timeout).toBe(300_000)
  })

  it('fail-fast: a hook that times out throws with exit 124 + raise-timeoutSeconds hint', async () => {
    mockExeca.mockResolvedValue({
      exitCode: undefined,
      timedOut: true,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    } as never)

    await expect(
      runRunHooks(
        '/wt',
        [{ command: ['bin/heavy-bootstrap'], timeoutSeconds: 600 }],
        tokens,
        'fail-fast',
      ),
    ).rejects.toThrow(/Run hook timed out after 600s.*Raise this hook's `timeoutSeconds`/)

    await expect(
      runRunHooks(
        '/wt',
        [{ command: ['bin/heavy-bootstrap'], timeoutSeconds: 600 }],
        tokens,
        'fail-fast',
      ),
    ).rejects.toThrow(/Exit code: 124/)
  })

  it('attempt-all: a hook timeout is logged as 124 and does not throw', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: undefined,
        timedOut: true,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks(
        '/wt',
        [{ command: ['bin/teardown-slow'], timeoutSeconds: 60 }, ['docker', 'down']],
        tokens,
        'attempt-all',
      ),
    ).resolves.toBeUndefined()

    const logged = JSON.stringify(mockLoggerWarn.mock.calls)
    expect(logged).toContain('124')
    expect(logged).toContain('timed out')
    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
  })

  it('attempt-all: a missing hook logs the spawn diagnostic and continues', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: undefined, code: 'ENOENT', stdout: '', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [['bin/missing'], ['docker', 'down']], tokens, 'attempt-all'),
    ).resolves.toBeUndefined()

    const logged = JSON.stringify(mockLoggerWarn.mock.calls)
    expect(logged).toContain('command not found')
    expect(logged).not.toContain('Exit code: undefined')
    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
  })
})
