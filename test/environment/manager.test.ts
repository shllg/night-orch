import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveEnvironmentMode,
  setupEnvironment,
  teardownEnvironment,
} from '../../src/environment/manager.js'
import type { RepoConfig } from '../../src/config/schema.js'

// Mock all sub-modules
vi.mock('../../src/environment/shared.js', () => ({
  validateSharedEnvironment: vi.fn(),
}))
vi.mock('../../src/environment/dedicated.js', () => ({
  startDedicatedStack: vi.fn(),
  stopDedicatedStack: vi.fn(),
}))
vi.mock('../../src/environment/bootstrap.js', () => ({
  runBootstrapCommands: vi.fn(),
}))
vi.mock('../../src/environment/env-file.js', () => ({
  setupEnvFile: vi.fn().mockReturnValue({ envOverrides: {}, allocatedPort: null }),
}))
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { validateSharedEnvironment } from '../../src/environment/shared.js'
import { startDedicatedStack, stopDedicatedStack } from '../../src/environment/dedicated.js'
import { runBootstrapCommands } from '../../src/environment/bootstrap.js'
import { setupEnvFile } from '../../src/environment/env-file.js'

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/home/user/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: ['no:blocked'],
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
    },
    defaults: {
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
      doneMode: 'pr-ready',
      notifyPriority: 'normal',
      prMentions: [],
    },
    verify: [],
    selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
    agents: {},
    ...overrides,
  } as RepoConfig
}

describe('resolveEnvironmentMode', () => {
  it('returns dedicated when issue has env:dedicated label', () => {
    expect(resolveEnvironmentMode(['env:dedicated', 'bug'], makeRepoConfig())).toBe('dedicated')
  })

  it('returns shared when issue has env:shared label', () => {
    expect(resolveEnvironmentMode(['env:shared'], makeRepoConfig())).toBe('shared')
  })

  it('returns config default when no env label present', () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        bootstrap: [],
        cleanup: [],
      },
    })
    expect(resolveEnvironmentMode(['bug'], config)).toBe('dedicated')
  })

  it('defaults to shared when no config and no label', () => {
    expect(resolveEnvironmentMode([], makeRepoConfig())).toBe('shared')
  })

  it('env:dedicated label takes priority over config default', () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'shared',
        bootstrap: [],
        cleanup: [],
      },
    })
    expect(resolveEnvironmentMode(['env:dedicated'], config)).toBe('dedicated')
  })
})

describe('setupEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates shared environment in shared mode', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'shared',
        shared: { requireRunning: true, healthcheck: 'curl localhost' },
        bootstrap: [],
        cleanup: [],
      },
    })

    const result = await setupEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: config,
      mode: 'shared',
      usedPorts: [],
    })

    expect(validateSharedEnvironment).toHaveBeenCalledWith('curl localhost', true)
    expect(result.mode).toBe('shared')
    expect(result.allocatedPort).toBeNull()
    expect(result.composeProjectName).toBeNull()
  })

  it('runs bootstrap commands for shared mode', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'shared',
        bootstrap: [{ command: 'pnpm install', when: 'always' as const }],
        cleanup: [],
      },
    })

    await setupEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: config,
      mode: 'shared',
      usedPorts: [],
    })

    expect(runBootstrapCommands).toHaveBeenCalledWith(
      '/tmp/wt',
      [{ command: 'pnpm install', when: 'always' }],
      'shared',
    )
  })

  it('throws when dedicated mode requested but no config', async () => {
    const config = makeRepoConfig()

    await expect(
      setupEnvironment({
        worktreePath: '/tmp/wt',
        issueNumber: 1,
        repoConfig: config,
        mode: 'dedicated',
        usedPorts: [],
      }),
    ).rejects.toThrow(/Dedicated mode requested but no dedicated config/)
  })

  it('starts dedicated stack in dedicated mode', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'docker-compose.yml',
            services: ['db'],
            projectName: 'orch-{issue}',
          },
          env: {
            copyFrom: '.env',
            overrides: {},
            overrideFiles: [],
          },
          teardownOnComplete: true,
        },
        bootstrap: [],
        cleanup: [],
      },
    })

    vi.mocked(setupEnvFile).mockReturnValue({ envOverrides: {}, allocatedPort: 5101 })

    const result = await setupEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 42,
      repoConfig: config,
      mode: 'dedicated',
      usedPorts: [],
    })

    expect(startDedicatedStack).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'orch-42',
        composeFile: 'docker-compose.yml',
        services: ['db'],
      }),
    )
    expect(result.mode).toBe('dedicated')
    expect(result.composeProjectName).toBe('orch-42')
  })

  it('substitutes {issue} in project name and env overrides', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'compose.yaml',
            services: [],
            projectName: 'night-{issue}',
          },
          env: {
            copyFrom: '.env',
            overrides: { DB_NAME: 'orch_{issue}_db' },
            overrideFiles: [],
          },
          teardownOnComplete: true,
        },
        bootstrap: [],
        cleanup: [],
      },
    })

    await setupEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 7,
      repoConfig: config,
      mode: 'dedicated',
      usedPorts: [],
    })

    expect(setupEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: { DB_NAME: 'orch_7_db' },
      }),
    )
    expect(startDedicatedStack).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'night-7' }),
    )
  })

  it('rolls back dedicated stack when bootstrap fails after startup', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'docker-compose.yml',
            services: ['db'],
            projectName: 'orch-{issue}',
          },
          env: {
            copyFrom: '.env',
            overrides: {},
            overrideFiles: [],
          },
          teardownOnComplete: true,
        },
        bootstrap: [{ command: 'pnpm install', when: 'dedicated' as const }],
        cleanup: [],
      },
    })

    vi.mocked(runBootstrapCommands).mockRejectedValueOnce(new Error('bootstrap failed'))

    await expect(
      setupEnvironment({
        worktreePath: '/tmp/wt',
        issueNumber: 42,
        repoConfig: config,
        mode: 'dedicated',
        usedPorts: [],
      }),
    ).rejects.toThrow('bootstrap failed')

    expect(startDedicatedStack).toHaveBeenCalled()
    expect(stopDedicatedStack).toHaveBeenCalledWith('/tmp/wt', 'docker-compose.yml', 'orch-42')
  })
})

describe('teardownEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op for shared mode', async () => {
    await teardownEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: makeRepoConfig(),
      mode: 'shared',
      composeProjectName: null,
    })

    expect(stopDedicatedStack).not.toHaveBeenCalled()
  })

  it('stops dedicated stack when teardownOnComplete is true', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'compose.yaml',
            services: [],
            projectName: 'orch-{issue}',
          },
          env: { copyFrom: '.env', overrides: {}, overrideFiles: [] },
          teardownOnComplete: true,
        },
        bootstrap: [],
        cleanup: [],
      },
    })

    await teardownEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: config,
      mode: 'dedicated',
      composeProjectName: 'orch-1',
    })

    expect(stopDedicatedStack).toHaveBeenCalledWith('/tmp/wt', 'compose.yaml', 'orch-1')
  })

  it('skips stop when teardownOnComplete is false', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'compose.yaml',
            services: [],
            projectName: 'orch-{issue}',
          },
          env: { copyFrom: '.env', overrides: {}, overrideFiles: [] },
          teardownOnComplete: false,
        },
        bootstrap: [],
        cleanup: [],
      },
    })

    await teardownEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: config,
      mode: 'dedicated',
      composeProjectName: 'orch-1',
    })

    expect(stopDedicatedStack).not.toHaveBeenCalled()
  })

  it('runs cleanup commands after teardown', async () => {
    const config = makeRepoConfig({
      environment: {
        defaultMode: 'dedicated',
        dedicated: {
          compose: {
            file: 'compose.yaml',
            services: [],
            projectName: 'orch-{issue}',
          },
          env: { copyFrom: '.env', overrides: {}, overrideFiles: [] },
          teardownOnComplete: true,
        },
        bootstrap: [],
        cleanup: [{ command: 'rm -rf tmp', when: 'dedicated' as const }],
      },
    })

    await teardownEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: config,
      mode: 'dedicated',
      composeProjectName: 'orch-1',
    })

    expect(runBootstrapCommands).toHaveBeenCalledWith(
      '/tmp/wt',
      [{ command: 'rm -rf tmp', when: 'dedicated' }],
      'dedicated',
    )
  })

  it('no-op when no dedicated config', async () => {
    await teardownEnvironment({
      worktreePath: '/tmp/wt',
      issueNumber: 1,
      repoConfig: makeRepoConfig(),
      mode: 'dedicated',
      composeProjectName: null,
    })

    expect(stopDedicatedStack).not.toHaveBeenCalled()
  })
})
