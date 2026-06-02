import { describe, it, expect } from 'vitest'
import { compilePRTitle, compilePRBody, type PRBodyContext } from '../../src/publishing/pr-body.js'

function makeContext(overrides: Partial<PRBodyContext> = {}): PRBodyContext {
  return {
    issue: { number: 42, title: 'Fix login timeout', url: 'https://github.com/org/repo/issues/42' },
    plan: {
      objective: 'Fix the login timeout issue',
      assumptions: [],
      filesToChange: ['src/auth.ts'],
      steps: [{ order: 1, description: 'Update timeout', files: ['src/auth.ts'] }],
      risks: [],
      testStrategy: 'Unit tests',
    },
    codeResult: {
      summary: 'Updated timeout value in auth module',
      changedFiles: ['src/auth.ts'],
      remainingUncertainty: null,
      blockers: null,
    },
    verifyResults: [
      { command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1000, passed: true },
      { command: 'pnpm lint', exitCode: 0, stdout: '', stderr: '', durationMs: 500, passed: true },
    ],
    reviewResult: {
      verdict: 'APPROVED',
      summary: 'Looks good',
      findings: [],
      definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
    },
    roles: { planner: 'claude', coder: 'codex', reviewer: 'claude' },
    iterationCount: 1,
    triageLevel: 'standard',
    ...overrides,
  }
}

describe('compilePRTitle', () => {
  it('follows format with label-derived prefix', () => {
    expect(compilePRTitle(42, 'Enable issues in projects', ['enhancement'])).toBe(
      '[FEAT] Enable issues in projects (night-orch / #42)',
    )
  })

  it('falls back to CHORE when no conventional label is present', () => {
    expect(compilePRTitle(42, 'Adjust queue handling', ['no:running'])).toBe(
      '[CHORE] Adjust queue handling (night-orch / #42)',
    )
  })

  it('truncates at 256 chars', () => {
    const longTitle = 'A'.repeat(300)
    const title = compilePRTitle(1, longTitle, ['bug'])
    expect(title.length).toBeLessThanOrEqual(256)
    expect(title).toContain('(night-orch / #1)')
    expect(title).toMatch(/^\[FIX\] /)
  })
})

describe('compilePRBody', () => {
  it('includes issue reference', () => {
    const body = compilePRBody(makeContext())
    expect(body).toContain('Closes #42')
  })

  it('includes plan summary', () => {
    const body = compilePRBody(makeContext())
    expect(body).toContain('Fix the login timeout issue')
  })

  it('includes verify results', () => {
    const body = compilePRBody(makeContext())
    expect(body).toContain('pnpm test')
    expect(body).toContain(':white_check_mark:')
  })

  it('includes each reviewer result when multiple reviewer slots ran', () => {
    const body = compilePRBody(makeContext({
      reviewResult: null,
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Main review passed',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
        cr: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'Code review requested parser hardening',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
        },
      },
    }))

    expect(body).toContain('### review')
    expect(body).toContain('Main review passed')
    expect(body).toContain('### cr')
    expect(body).toContain('Code review requested parser hardening')
  })

  it('includes agent roles and metadata', () => {
    const body = compilePRBody(makeContext())
    expect(body).toContain('plan=claude')
    expect(body).toContain('code=codex')
    expect(body).toContain('standard')
  })

  it('handles null plan gracefully', () => {
    const body = compilePRBody(makeContext({ plan: null }))
    expect(body).not.toContain('## Plan')
    expect(body).toContain('Closes #42')
  })

  it('handles null code result', () => {
    const body = compilePRBody(makeContext({ codeResult: null }))
    expect(body).not.toContain('## Implementation')
  })
})
