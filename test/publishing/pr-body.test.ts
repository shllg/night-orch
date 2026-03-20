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
  it('follows format', () => {
    expect(compilePRTitle(42, 'Fix login')).toBe('[night-orch] #42 Fix login')
  })

  it('truncates at 256 chars', () => {
    const longTitle = 'A'.repeat(300)
    const title = compilePRTitle(1, longTitle)
    expect(title.length).toBeLessThanOrEqual(256)
    expect(title).toMatch(/\.\.\.$/)
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
