import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { compilePrompt } from '../../../src/workers/prompt/compiler.js'
import type { PromptContext } from '../../../src/workers/types.js'
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Suppress logger
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    role: 'planner',
    issue: {
      number: 42,
      title: 'Fix login timeout',
      body: 'The login page times out after 10 seconds.',
      labels: ['bug', 'no:ready'],
    },
    repo: {
      name: 'org/repo',
      baseBranch: 'main',
    },
    plan: null,
    diff: null,
    reviewFindings: null,
    verifyResults: null,
    iteration: {
      current: 1,
      max: 4,
      isRetry: false,
    },
    triageLevel: 'standard',
    ...overrides,
  }
}

describe('compilePrompt', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-compiler-test-'))
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses default template when no file provided', () => {
    const { systemPrompt } = compilePrompt(
      null,
      'You are a {{role}} for {{repo.name}}.',
      makeContext(),
    )

    expect(systemPrompt).toBe('You are a planner for org/repo.')
  })

  it('loads template from file when path provided', () => {
    const templatePath = join(tmpDir, 'template.md')
    writeFileSync(templatePath, 'Custom: {{issue.title}} on {{repo.baseBranch}}')

    const { systemPrompt } = compilePrompt(templatePath, 'default', makeContext())

    expect(systemPrompt).toBe('Custom: <issue_title>Fix login timeout</issue_title> on main')
  })

  it('falls back to default when template file not found', () => {
    const { systemPrompt } = compilePrompt(
      '/nonexistent/template.md',
      'Default: {{role}}',
      makeContext(),
    )

    expect(systemPrompt).toBe('Default: planner')
  })

  it('substitutes all context variables', () => {
    const template = [
      'Role: {{role}}',
      'Issue: #{{issue.number}} {{issue.title}}',
      'Labels: {{issue.labels}}',
      'Repo: {{repo.name}} ({{repo.baseBranch}})',
      'Iteration: {{iteration.current}}/{{iteration.max}}',
      'Retry: {{iteration.isRetry}}',
      'Triage: {{triageLevel}}',
    ].join('\n')

    const { systemPrompt } = compilePrompt(null, template, makeContext())

    expect(systemPrompt).toContain('Role: planner')
    expect(systemPrompt).toContain('Issue: #42 <issue_title>Fix login timeout</issue_title>')
    expect(systemPrompt).toContain('Labels: bug, no:ready')
    expect(systemPrompt).toContain('Repo: org/repo (main)')
    expect(systemPrompt).toContain('Iteration: 1/4')
    expect(systemPrompt).toContain('Retry: false')
    expect(systemPrompt).toContain('Triage: standard')
  })

  it('leaves unknown variables as-is', () => {
    const { systemPrompt } = compilePrompt(null, '{{unknown.var}}', makeContext())
    expect(systemPrompt).toBe('{{unknown.var}}')
  })

  it('builds user prompt with issue details', () => {
    const { userPrompt } = compilePrompt(null, '', makeContext())

    expect(userPrompt).toContain('## Issue Context')
    expect(userPrompt).toContain('<untrusted_issue>')
    expect(userPrompt).toContain('<title>Fix login timeout</title>')
    expect(userPrompt).toContain('<body>The login page times out after 10 seconds.</body>')
  })

  it('includes plan in user prompt when available', () => {
    const ctx = makeContext({ plan: 'Step 1: Fix the timeout\nStep 2: Add tests' })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Implementation Plan')
    expect(userPrompt).toContain('Step 1: Fix the timeout')
  })

  it('includes review findings in user prompt', () => {
    const ctx = makeContext({
      reviewFindings: [
        { severity: 'major', message: 'Missing error handling', suggestedFix: 'Add try/catch' },
        { severity: 'minor', message: 'Style issue', suggestedFix: null },
      ],
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Review Findings to Address')
    expect(userPrompt).toContain('[major] Missing error handling')
    expect(userPrompt).toContain('Suggested fix: Add try/catch')
    expect(userPrompt).toContain('[minor] Style issue')
  })

  it('includes verify results in user prompt', () => {
    const ctx = makeContext({
      verifyResults: [
        { command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1000, passed: true },
        { command: 'pnpm lint', exitCode: 1, stdout: '', stderr: 'Error: no-unused-vars', durationMs: 500, passed: false },
      ],
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Verification Results')
    expect(userPrompt).toContain('✓ pnpm test')
    expect(userPrompt).toContain('✗ pnpm lint')
    expect(userPrompt).toContain('stderr: Error: no-unused-vars')
  })

  it('includes retry notice when isRetry is true', () => {
    const ctx = makeContext({
      iteration: { current: 2, max: 4, isRetry: true },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Iteration 2/4')
    expect(userPrompt).toContain('This is a retry')
  })

  it('includes follow-up context as untrusted input', () => {
    const ctx = makeContext({
      followup: {
        type: 'ci_failure',
        summary: 'Continue requested with failing CI checks',
        context: '## CI\n- [FAIL] pnpm test',
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Follow-up Context')
    expect(userPrompt).toContain('<untrusted_followup>')
    expect(userPrompt).toContain('<type>ci_failure</type>')
    expect(userPrompt).toContain('<summary>Continue requested with failing CI checks</summary>')
    expect(userPrompt).toContain('<context>CI')
  })

  it('includes structured conflict snapshots without stripping excerpts', () => {
    const ctx = makeContext({
      followup: {
        type: 'refresh_conflict',
        summary: 'Branch refresh conflicted',
        context: 'Refresh conflicted with upstream changes.',
        conflictSnapshot: {
          schemaVersion: 1,
          capturedAt: '2026-04-14T00:00:00Z',
          source: 'branch_refresh',
          kind: 'merge',
          strategy: 'merge',
          summary: 'Refresh against origin/main hit conflicts in 1 file.',
          branchName: 'orch/42-fix',
          baseBranch: 'main',
          branchHeadSha: 'abc123',
          baseHeadSha: 'def456',
          files: ['src/main.ts'],
          excerpts: [{
            path: 'src/main.ts',
            preview: '<<<<<<< ours\nconst shared = 1\n=======\nconst shared = 2\n>>>>>>> theirs',
            ours: 'const shared = 1',
            theirs: 'const shared = 2',
          }],
          resolution: {
            attempted: true,
            outcome: 'unresolved',
            files: ['src/main.ts'],
          },
        },
      },
    })

    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('## Conflict Snapshot')
    expect(userPrompt).toContain('<untrusted_conflict_snapshot>')
    expect(userPrompt).toContain('<source>branch_refresh</source>')
    expect(userPrompt).toContain('<file>src/main.ts</file>')
    expect(userPrompt).toContain('&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours')
    expect(userPrompt).toContain('<resolver_attempt>')
  })

  it('formats follow-up template substitutions as untrusted xml', () => {
    const ctx = makeContext({
      followup: {
        type: 'ci_failure',
        summary: 'Fix the checks',
        context: 'Line one <script>alert(1)</script>',
      },
    })
    const { systemPrompt } = compilePrompt(
      null,
      '{{followup.type}}\n{{followup.summary}}\n{{followup.context}}',
      ctx,
    )

    expect(systemPrompt).toContain('<followup_type>ci_failure</followup_type>')
    expect(systemPrompt).toContain('<followup_summary>Fix the checks</followup_summary>')
    expect(systemPrompt).toContain('<followup_context>Line one alert(1)</followup_context>')
    expect(systemPrompt).not.toContain('<script>')
  })

  it('sanitizes and truncates follow-up context', () => {
    const ctx = makeContext({
      followup: {
        type: 'review_comment',
        summary: 'Needs fixes',
        context: `<script>alert('x')</script>${'A'.repeat(6000)}`,
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).not.toContain('<script>')
    expect(userPrompt).toContain('[... truncated ...]')
  })

  it('sanitizes HTML tags from issue body', () => {
    const ctx = makeContext({
      issue: {
        number: 1,
        title: 'Test',
        body: 'Hello <script>alert("xss")</script> world',
        labels: [],
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).not.toContain('<script>')
    expect(userPrompt).toContain('Hello alert(&quot;xss&quot;) world')
  })

  it('sanitizes HTML comments from issue body', () => {
    const ctx = makeContext({
      issue: {
        number: 1,
        title: 'Test',
        body: 'Before <!-- IGNORE THIS --> After',
        labels: [],
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).not.toContain('IGNORE THIS')
    expect(userPrompt).toContain('<body>Before After</body>')
  })

  it('truncates excessively long issue bodies', () => {
    const longBody = 'A'.repeat(5000)
    const ctx = makeContext({
      issue: { number: 1, title: 'Test', body: longBody, labels: [] },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('[... truncated ...]')
    // Body should be capped at ~4000 chars + truncation notice
    expect(userPrompt.length).toBeLessThan(longBody.length)
  })

  it('strips markdown links and images from issue body', () => {
    const ctx = makeContext({
      issue: {
        number: 1,
        title: 'Test',
        body: 'See [details](https://example.com) and ![img](https://example.com/a.png)',
        labels: [],
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('details [link removed]')
    expect(userPrompt).toContain('[image removed]')
    expect(userPrompt).not.toContain('https://example.com')
  })

  it('preserves fenced and inline code in issue body for reproducible context', () => {
    const ctx = makeContext({
      issue: {
        number: 1,
        title: 'Repro',
        body: 'Run this:\n```sh\npnpm test -- --run test/foo.test.ts\n```\nThen try `--update`.',
        labels: [],
      },
    })
    const { userPrompt } = compilePrompt(null, '', ctx)

    expect(userPrompt).toContain('```sh')
    expect(userPrompt).toContain('pnpm test -- --run test/foo.test.ts')
    expect(userPrompt).toContain('`--update`')
  })
})
