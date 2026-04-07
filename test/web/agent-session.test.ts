import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { InteractiveAgentSessionManager } from '../../src/web/agent-session.js'

const originalTmpDir = process.env['TMPDIR']

afterEach(() => {
  if (originalTmpDir === undefined) {
    delete process.env['TMPDIR']
  } else {
    process.env['TMPDIR'] = originalTmpDir
  }
})

describe('InteractiveAgentSessionManager', () => {
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

function makeConfig(): Config {
  return {
    storage: {
      worktreeRoot: '/tmp/night-orch-worktrees',
    },
    workerProfiles: {
      codexTest: {
        type: 'codex',
        command: 'sh',
        args: ['-c', 'cat >/dev/null'],
        workerTimeoutSeconds: 2,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
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
