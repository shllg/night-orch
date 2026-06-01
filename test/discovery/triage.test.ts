import { describe, it, expect, vi } from 'vitest'
import {
  classifyInboxTriage,
  deriveInboxCommandHints,
  triageIssue,
  triageIssueWithAi,
} from '../../src/discovery/triage.js'
import type { ForgeIssue } from '../../src/forge/types.js'
import type { AiClient } from '../../src/ai/types.js'
import { AiTransientError } from '../../src/ai/errors.js'

function makeIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    nodeId: 'MDU6SXNzdWUx',
    title: 'Test issue',
    body: 'Fix the thing',
    labels: [],
    assignees: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/org/repo/issues/1',
    ...overrides,
  }
}

describe('triageIssue', () => {
  it('classifies short bug issue as trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['bug'], body: 'Fix the typo' }))
    expect(result.level).toBe('trivial')
  })

  it('classifies short typo issue as trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['typo'], body: 'Wrong word' }))
    expect(result.level).toBe('trivial')
  })

  it('classifies standard feature request as standard', () => {
    const result = triageIssue(
      makeIssue({
        labels: ['enhancement'],
        body: 'Add a new button to the settings page that allows users to configure their notification preferences. This should include email, SMS, and push notification toggles.',
      }),
    )
    expect(result.level).toBe('standard')
  })

  it('classifies issue with refactor label as architectural', () => {
    const result = triageIssue(makeIssue({ labels: ['refactor'] }))
    expect(result.level).toBe('architectural')
  })

  it('classifies issue with breaking label as architectural', () => {
    const result = triageIssue(makeIssue({ labels: ['breaking'] }))
    expect(result.level).toBe('architectural')
  })

  it('classifies issue with 5+ file references as architectural', () => {
    const result = triageIssue(
      makeIssue({
        body: `Changes needed in:
src/auth/login.ts
src/auth/session.ts
src/models/user.ts
src/routes/api.ts
src/middleware/cors.ts
src/config/defaults.ts`,
      }),
    )
    expect(result.level).toBe('architectural')
  })

  it('architectural label takes priority over trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['bug', 'refactor'], body: 'Short' }))
    expect(result.level).toBe('architectural')
  })

  it('does not count file references inside code blocks as architectural', () => {
    const result = triageIssue(
      makeIssue({
        body: `Add a helper that imports these modules:

\`\`\`typescript
import { foo } from './auth/login.ts'
import { bar } from './auth/session.ts'
import { baz } from './models/user.ts'
import { qux } from './routes/api.ts'
import { quux } from './middleware/cors.ts'
import { corge } from './config/defaults.ts'
\`\`\``,
      }),
    )
    expect(result.level).toBe('standard')
  })

  it('does not count file references inside inline code as architectural', () => {
    const result = triageIssue(
      makeIssue({
        body: 'Update `src/auth/login.ts`, `src/auth/session.ts`, `src/models/user.ts`, `src/routes/api.ts`, `src/middleware/cors.ts`, and `src/config/defaults.ts`',
      }),
    )
    expect(result.level).toBe('standard')
  })

  it('long body with bug label is standard, not trivial', () => {
    const longBody = 'A'.repeat(300)
    const result = triageIssue(makeIssue({ labels: ['bug'], body: longBody }))
    expect(result.level).toBe('standard')
  })
})

describe('triageIssueWithAi (Phase 3)', () => {
  function makeAiClient(
    completeStructured: AiClient['completeStructured'],
  ): AiClient {
    return {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      complete: vi.fn(),
      completeStructured,
    }
  }

  it('returns the rule-based result when ai is null', async () => {
    const result = await triageIssueWithAi(makeIssue({ labels: ['bug'], body: 'typo' }), null)
    expect(result.level).toBe('trivial')
    expect(result.reason).not.toContain('LLM:')
  })

  it('overrides the rule-based result with the LLM classification', async () => {
    const ai = makeAiClient(
      vi.fn().mockResolvedValue({
        level: 'architectural',
        reason: 'touches multiple subsystems',
      }),
    )
    const result = await triageIssueWithAi(
      makeIssue({ labels: ['bug'], body: 'typo' }),
      ai,
    )
    expect(result.level).toBe('architectural')
    expect(result.reason).toContain('LLM:')
    expect(result.reason).toContain('touches multiple subsystems')
  })

  it('falls back to rule-based result on AiTransientError', async () => {
    const ai = makeAiClient(
      vi.fn().mockRejectedValue(new AiTransientError('anthropic', 'claude-3-5-sonnet', 'network')),
    )
    const result = await triageIssueWithAi(makeIssue({ labels: ['bug'], body: 'typo' }), ai)
    expect(result.level).toBe('trivial') // heuristic
    expect(result.reason).not.toContain('LLM:')
  })

  it('falls back to rule-based result on unexpected errors', async () => {
    const ai = makeAiClient(vi.fn().mockRejectedValue(new Error('boom')))
    const result = await triageIssueWithAi(makeIssue({ body: 'A'.repeat(200) }), ai)
    expect(result.level).toBe('standard')
  })
})

describe('inbox triage helpers', () => {
  it('classifies reviewer-blocked and manual rebase states as needs_human', () => {
    expect(
      classifyInboxTriage({
        status: 'blocked',
        block_reason: 'reviewer_blocked',
        manual_state: null,
      }),
    ).toBe('needs_human')

    expect(
      classifyInboxTriage({
        status: 'blocked',
        block_reason: null,
        manual_state: 'awaiting_rebase_resolution',
      }),
    ).toBe('needs_human')
  })

  it('classifies review_ready and error states directly', () => {
    expect(
      classifyInboxTriage({
        status: 'review_ready',
        block_reason: null,
        manual_state: null,
      }),
    ).toBe('review_ready')

    expect(
      classifyInboxTriage({
        status: 'error',
        block_reason: null,
        manual_state: null,
      }),
    ).toBe('error')
  })

  it('defaults remaining blocked states to blocked', () => {
    expect(
      classifyInboxTriage({
        status: 'blocked',
        block_reason: 'merge_conflict',
        manual_state: null,
      }),
    ).toBe('blocked')
  })

  it('derives retry hints for error rows', () => {
    expect(
      deriveInboxCommandHints({
        status: 'error',
        block_reason: null,
        manual_state: null,
      }),
    ).toEqual({
      recommendedCommand: '/orch retry',
      availableCommands: ['/orch retry'],
    })
  })

  it('derives continue/retry hints for followup resolution paths', () => {
    expect(
      deriveInboxCommandHints({
        status: 'blocked',
        block_reason: 'merge_conflict',
        manual_state: null,
      }),
    ).toEqual({
      recommendedCommand: '/orch continue',
      availableCommands: ['/orch continue', '/orch retry'],
    })
  })
})
