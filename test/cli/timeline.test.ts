import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockBuildTimeline,
  mockClose,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockBuildTimeline: vi.fn(),
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

vi.mock('../../src/state/timeline.js', () => ({
  buildTimeline: (...args: unknown[]) => mockBuildTimeline(...args),
}))

import { timelineCommand } from '../../src/cli/commands/timeline.js'

const FIXTURE_ENTRIES = [
  {
    ts: Date.parse('2026-06-04T10:00:00.000Z'),
    kindWeight: 1,
    id: 1,
    kind: 'phase',
    source: 'system',
    phase: 'plan',
    summary: 'phase_started',
  },
  {
    ts: Date.parse('2026-06-04T10:00:10.000Z'),
    kindWeight: 2,
    id: 1,
    kind: 'handoff',
    source: 'agent',
    phase: 'plan',
    summary: 'plan: ok',
  },
]

describe('timelineCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockLoadConfig.mockReturnValue({ storage: { dbPath: '/tmp/state.db' } })
    mockInitDatabase.mockReturnValue({ close: mockClose })
    mockBuildTimeline.mockReturnValue(FIXTURE_ENTRIES)
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
    process.exitCode = undefined
  })

  it('prints chronological timeline entries with formatted columns', async () => {
    await timelineCommand('run-1', {})

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n')
    expect(output).toContain('night-orch timeline: run-1')
    expect(output).toContain('phase')
    expect(output).toContain('handoff')
    expect(output).toContain('phase_started')
    expect(output).toContain('plan: ok')
    expect(mockBuildTimeline).toHaveBeenCalledWith({ close: mockClose }, 'run-1', {})
    expect(mockClose).toHaveBeenCalled()
  })

  it('parses --source filter and passes to buildTimeline', async () => {
    await timelineCommand('run-1', { source: 'agent,user' })

    const callOpts = mockBuildTimeline.mock.calls[0]?.[2] as Record<string, unknown>
    expect(callOpts['sources']).toEqual(['agent', 'user'])
  })

  it('parses --kind filter', async () => {
    await timelineCommand('run-1', { kind: 'handoff,cost' })

    const callOpts = mockBuildTimeline.mock.calls[0]?.[2] as Record<string, unknown>
    expect(callOpts['kinds']).toEqual(['handoff', 'cost'])
  })

  it('parses --since as ISO timestamp', async () => {
    await timelineCommand('run-1', { since: '2026-06-04T10:00:00.000Z' })

    const callOpts = mockBuildTimeline.mock.calls[0]?.[2] as Record<string, unknown>
    expect(callOpts['sinceMs']).toBe(Date.parse('2026-06-04T10:00:00.000Z'))
  })

  it('parses --limit', async () => {
    await timelineCommand('run-1', { limit: '50' })

    const callOpts = mockBuildTimeline.mock.calls[0]?.[2] as Record<string, unknown>
    expect(callOpts['limit']).toBe(50)
  })

  it('rejects unknown source', async () => {
    await timelineCommand('run-1', { source: 'rogue' })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Unknown source: rogue')
  })

  it('rejects unknown kind', async () => {
    await timelineCommand('run-1', { kind: 'nope' })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Unknown kind: nope')
  })

  it('rejects invalid --since', async () => {
    await timelineCommand('run-1', { since: 'not-a-date' })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Invalid --since')
  })

  it('prints "none" when no entries', async () => {
    mockBuildTimeline.mockReturnValue([])
    await timelineCommand('run-1', {})

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n')
    expect(output).toContain('none')
  })
})
