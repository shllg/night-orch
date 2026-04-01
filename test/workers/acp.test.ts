import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AcpWorkerAdapter } from '../../src/workers/acp.js'
import type { WorkerTaskInput, WorkerProfileInput } from '../../src/workers/types.js'

const mockRunOnce = vi.fn()
const mockSendSessionDirect = vi.fn()

vi.mock('../../src/workers/acpx-imports.js', () => ({
  loadAcpxRuntime: vi.fn().mockResolvedValue({
    runOnce: (...args: unknown[]) => mockRunOnce(...args),
    sendSessionDirect: (...args: unknown[]) => mockSendSessionDirect(...args),
  }),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const acpProfile: WorkerProfileInput = {
  type: 'acp',
  command: 'codex',
  args: [],
  workerTimeoutSeconds: 60,
  minimalEnv: true,
  runtimeWrapper: null,
  env: {},
}

function makeInput(overrides: Partial<WorkerTaskInput> = {}): WorkerTaskInput {
  return {
    role: 'planner',
    worktreePath: '/tmp/wt',
    prompt: 'Plan the fix',
    profile: acpProfile,
    timeoutSeconds: 60,
    env: { PATH: '/usr/bin' },
    ...overrides,
  }
}

describe('AcpWorkerAdapter', () => {
  let adapter: AcpWorkerAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new AcpWorkerAdapter()
  })

  it('calls runOnce for fresh invocations', async () => {
    mockRunOnce.mockResolvedValue({
      stopReason: 'end_turn',
      sessionId: 'ses-123',
      permissionStats: {},
    })

    const result = await adapter.runTask(makeInput())

    expect(mockRunOnce).toHaveBeenCalledTimes(1)
    expect(mockRunOnce).toHaveBeenCalledWith(expect.objectContaining({ env: { PATH: '/usr/bin' } }))
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('ses-123')
  })

  it('calls sendSessionDirect when continueSessionId is provided', async () => {
    mockSendSessionDirect.mockResolvedValue({
      stopReason: 'end_turn',
      permissionStats: {},
      sessionId: 'ses-123',
      record: {},
      resumed: true,
    })

    const result = await adapter.runTask(makeInput({ continueSessionId: 'ses-123' }))

    expect(mockSendSessionDirect).toHaveBeenCalledTimes(1)
    expect(mockSendSessionDirect).toHaveBeenCalledWith(expect.objectContaining({ env: { PATH: '/usr/bin' } }))
    expect(mockRunOnce).not.toHaveBeenCalled()
  })

  it('falls back to runOnce when session resume fails', async () => {
    mockSendSessionDirect.mockRejectedValue(new Error('session not found'))
    mockRunOnce.mockResolvedValue({
      stopReason: 'end_turn',
      sessionId: 'ses-new',
      permissionStats: {},
    })

    const result = await adapter.runTask(makeInput({ continueSessionId: 'ses-old' }))

    expect(mockSendSessionDirect).toHaveBeenCalledTimes(1)
    expect(mockRunOnce).toHaveBeenCalledTimes(1)
    expect(mockRunOnce).toHaveBeenCalledWith(expect.objectContaining({ env: { PATH: '/usr/bin' } }))
    expect(result.sessionId).toBe('ses-new')
  })

  it('maps timeout to timedOut flag', async () => {
    const timeoutError = new Error('timeout')
    ;(timeoutError as Record<string, unknown>)['outputCode'] = 'TIMEOUT'
    mockRunOnce.mockRejectedValue(timeoutError)

    const result = await adapter.runTask(makeInput())

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(1)
  })
})
