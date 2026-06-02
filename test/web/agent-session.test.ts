import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, WorkerProfile } from '../../src/config/schema.js'
import { InteractiveAgentSessionManager } from '../../src/web/agent-session.js'
import { streamingExec } from '../../src/workers/streaming-exec.js'

vi.mock('../../src/workers/streaming-exec.js', () => ({
  streamingExec: vi.fn().mockResolvedValue({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
  }),
}))

const originalTmpDir = process.env['TMPDIR']
const mockStreamingExec = vi.mocked(streamingExec)

beforeEach(() => {
  mockStreamingExec.mockClear()
})

afterEach(() => {
  if (originalTmpDir === undefined) {
    delete process.env['TMPDIR']
  } else {
    process.env['TMPDIR'] = originalTmpDir
  }
})

describe('InteractiveAgentSessionManager', () => {
  it('defaults Claude interactive sessions to --permission-mode plan', async () => {
    const manager = new InteractiveAgentSessionManager(makeConfig({
      claudeTest: {
        type: 'claude',
        command: 'claude',
        args: [],
        workerTimeoutSeconds: 2,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
        sandbox: { type: 'host', mounts: [], env: {} },
        allowAgentSessionBypass: false,
      },
    }), {
      workspacePath: '/tmp/night-orch-workspace',
    })

    const session = manager.createSession({ agent: 'claude', profileName: 'claudeTest' })
    manager.sendPrompt(session.id, 'hello')
    await waitForSessionToSettle(manager, session.id)

    const options = mockStreamingExec.mock.calls[0]?.[0]
    expect(options).toBeDefined()
    expect(options?.args).toContain('--permission-mode')
    expect(options?.args[options.args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('rejects unsafe Claude permission modes unless the profile opts in', async () => {
    const manager = new InteractiveAgentSessionManager(makeConfig({
      claudeUnsafe: {
        type: 'claude',
        command: 'claude',
        args: ['--permission-mode', 'bypassPermissions'],
        workerTimeoutSeconds: 2,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
        sandbox: { type: 'host', mounts: [], env: {} },
        allowAgentSessionBypass: false,
      },
    }), {
      workspacePath: '/tmp/night-orch-workspace',
    })

    const session = manager.createSession({ agent: 'claude', profileName: 'claudeUnsafe' })
    manager.sendPrompt(session.id, 'hello')
    await waitForSessionToSettle(manager, session.id)

    expect(mockStreamingExec).not.toHaveBeenCalled()
    expect(manager.getSession(session.id)?.lastError).toMatch(/allowAgentSessionBypass/i)
  })

  it('allows unsafe Claude permission modes when the profile opts in', async () => {
    const manager = new InteractiveAgentSessionManager(makeConfig({
      claudeTrusted: {
        type: 'claude',
        command: 'claude',
        args: ['--permission-mode', 'bypassPermissions'],
        workerTimeoutSeconds: 2,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
        sandbox: { type: 'host', mounts: [], env: {} },
        allowAgentSessionBypass: true,
      },
    }), {
      workspacePath: '/tmp/night-orch-workspace',
    })

    const session = manager.createSession({ agent: 'claude', profileName: 'claudeTrusted' })
    manager.sendPrompt(session.id, 'hello')
    await waitForSessionToSettle(manager, session.id)

    expect(mockStreamingExec).toHaveBeenCalledOnce()
    expect(manager.getSession(session.id)?.status).toBe('idle')
  })

  it('requires an explicit workspace path', () => {
    expect(() => new InteractiveAgentSessionManager(makeConfig())).toThrow(/workspacePath/i)
  })

  it('does not strand session state in running when codex temp-dir setup fails', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'night-orch-agent-session-test-'))
    const tmpFile = join(tmpRoot, 'not-a-directory')
    await writeFile(tmpFile, 'x')
    process.env['TMPDIR'] = tmpFile
    try {
      const manager = new InteractiveAgentSessionManager(makeConfig(), {
        workspacePath: '/tmp/night-orch-workspace',
      })

      const session = manager.createSession({ agent: 'codex' })
      const first = manager.sendPrompt(session.id, 'hello')
      expect(first.accepted).toBe(true)

      await waitForSessionToSettle(manager, session.id)

      const settled = manager.getSession(session.id)
      expect(settled?.status).toBe('failed')
      expect(settled?.runningTurnId).toBeNull()
      expect(settled?.lastError).toBeTruthy()

      // A second prompt should not be blocked by a stale "running" state.
      expect(() => manager.sendPrompt(session.id, 'second turn')).not.toThrow('running prompt')
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

function makeConfig(workerProfiles?: Record<string, WorkerProfile>): Config {
  return {
    storage: {
      worktreeRoot: '/tmp/night-orch-worktrees',
    },
    workerProfiles: workerProfiles ?? {
      codexTest: {
        type: 'codex',
        command: 'sh',
        args: ['-c', 'cat >/dev/null'],
        workerTimeoutSeconds: 2,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
        sandbox: { type: 'host', mounts: [], env: {} },
        allowAgentSessionBypass: false,
      },
    },
  } as unknown as Config
}

async function waitForSessionToSettle(
  manager: InteractiveAgentSessionManager,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const session = manager.getSession(sessionId)
    if (!session || session.status !== 'running') {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for session to settle')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
