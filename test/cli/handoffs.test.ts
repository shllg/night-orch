import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockListHandoffs,
  mockClose,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockListHandoffs: vi.fn(),
  mockClose: vi.fn(),
}))

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  resolveConfigPath: (...args: unknown[]) => mockResolveConfigPath(...args),
  ConfigError: class ConfigError extends Error {
    details?: string[]
  },
}))

vi.mock('../../src/state/db.js', () => ({
  initDatabase: (...args: unknown[]) => mockInitDatabase(...args),
}))

vi.mock('../../src/state/handoffs.js', () => ({
  listHandoffs: (...args: unknown[]) => mockListHandoffs(...args),
}))

import { handoffsCommand } from '../../src/cli/commands/handoffs.js'

describe('handoffsCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mockLoadConfig.mockReturnValue({ storage: { dbPath: '/tmp/state.db' } })
    mockInitDatabase.mockReturnValue({ close: mockClose })
    mockListHandoffs.mockReturnValue([
      {
        id: 1,
        runId: 'run-1',
        attemptId: 'run-1',
        stepId: 'plan',
        fromRole: 'planner',
        toRole: 'coder',
        kind: 'plan',
        summary: 'Plan: Fix issue',
        contentMd: '## Plan\n\nObjective: Fix issue\n\nAssumptions:\n- none',
        contentJson: { objective: 'Fix issue' },
        tokenUsage: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 2,
        runId: 'run-1',
        attemptId: 'run-1',
        stepId: 'review',
        fromRole: 'reviewer',
        toRole: 'system',
        kind: 'review-findings',
        summary: 'Review: APPROVED',
        contentMd: '## Review Findings',
        contentJson: { verdict: 'APPROVED' },
        tokenUsage: { promptTokens: 10, completionTokens: 5 },
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    ])
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.exitCode = undefined
  })

  it('prints ordered handoffs with collapsed markdown previews', async () => {
    await handoffsCommand('run-1')

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n')
    expect(output).toContain('night-orch handoffs: run-1')
    expect(output).toContain('[1] plan  plan  planner -> coder')
    expect(output).toContain('Plan: Fix issue')
    expect(output).toContain('## Plan')
    expect(output).toContain('Objective: Fix issue')
    expect(output).toContain('...')
    expect(output).toContain('[2] review-findings  review  reviewer -> system')
    expect(mockInitDatabase).toHaveBeenCalledWith('/tmp/state.db')
    expect(mockListHandoffs).toHaveBeenCalled()
    expect(mockClose).toHaveBeenCalled()
  })
})
