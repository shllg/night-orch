import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiClient } from '../../src/ai/types.js'
import { createConflictResolver } from '../../src/ops/conflict-resolver.js'
import type { Config } from '../../src/config/schema.js'

const mockComplete = vi.fn()
const mockCreateAiClient = vi.fn()
const mockBuildResolverPrompt = vi.fn()

vi.mock('../../src/ai/factory.js', () => ({
  createAiClient: (...args: unknown[]) => mockCreateAiClient(...args),
}))

vi.mock('../../src/workers/prompt/resolver-prompt.js', () => ({
  buildResolverPrompt: (...args: unknown[]) => mockBuildResolverPrompt(...args),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

function makeConfig(): Config {
  return {
    ai: {
      internal: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        apiKeyEnv: 'TEST_OPENAI_KEY',
        timeoutMs: 30_000,
        maxTokens: 1024,
        features: {
          conflictResolver: true,
        },
        enable: {
          triage: false,
          reviewerParseFallback: false,
          prBody: false,
        },
      },
    },
    autoResolveConflicts: {
      enabled: true,
      maxAttempts: 2,
      maxFiles: 1,
    },
  } as unknown as Config
}

describe('createConflictResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['TEST_OPENAI_KEY'] = 'test-key'
    mockCreateAiClient.mockReturnValue({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      complete: mockComplete,
      completeStructured: vi.fn(),
    } satisfies Partial<AiClient>)
    mockBuildResolverPrompt.mockReturnValue({
      system: 'system prompt',
      user: 'user prompt',
    })
  })

  it('returns unresolved when the conflict spans more than maxFiles', async () => {
    const resolver = createConflictResolver({ config: makeConfig() })
    const result = await resolver!.resolveConflicts(
      [
        { path: 'a.ts', mergedWithMarkers: 'a', base: 'a', ours: 'a', theirs: 'a' },
        { path: 'b.ts', mergedWithMarkers: 'b', base: 'b', ours: 'b', theirs: 'b' },
      ],
      { issueTitle: 'Test', issueBody: 'Body' },
      { repo: 'org/repo', issueNumber: 1, attempt: 1 },
    )

    expect(result).toMatchObject({
      ok: false,
      outcome: 'unresolved',
    })
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('passes full sources to the prompt builder and returns resolved files', async () => {
    mockComplete.mockResolvedValue({
      text: 'resolved file content\n',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
      resolvedModel: 'gpt-4.1-mini',
    })

    const config = {
      ...makeConfig(),
      autoResolveConflicts: {
        enabled: true,
        maxAttempts: 2,
        maxFiles: 5,
      },
    } as Config
    const resolver = createConflictResolver({ config })
    const source = {
      path: 'src/example.ts',
      mergedWithMarkers: '<<<<<<< ours\nconst a = 1\n=======\nconst b = 2\n>>>>>>> theirs\n',
      base: 'const base = 0\n',
      ours: 'const a = 1\n',
      theirs: 'const b = 2\n',
    }

    const result = await resolver!.resolveConflicts(
      [source],
      { issueTitle: 'Issue title', issueBody: 'Issue body' },
      { repo: 'org/repo', issueNumber: 1, attempt: 1 },
    )

    expect(mockBuildResolverPrompt).toHaveBeenCalledWith(source, {
      issueTitle: 'Issue title',
      issueBody: 'Issue body',
    })
    expect(result).toEqual({
      ok: true,
      files: [{ path: 'src/example.ts', resolved: 'resolved file content\n' }],
    })
  })

  it('returns error when the AI call throws', async () => {
    mockComplete.mockRejectedValue(new Error('boom'))

    const config = {
      ...makeConfig(),
      autoResolveConflicts: {
        enabled: true,
        maxAttempts: 2,
        maxFiles: 5,
      },
    } as Config
    const resolver = createConflictResolver({ config })
    const result = await resolver!.resolveConflicts(
      [{ path: 'src/example.ts', mergedWithMarkers: 'x', base: 'x', ours: 'x', theirs: 'x' }],
      { issueTitle: 'Issue title', issueBody: 'Issue body' },
      { repo: 'org/repo', issueNumber: 1, attempt: 1 },
    )

    expect(result).toMatchObject({
      ok: false,
      outcome: 'error',
    })
  })
})
