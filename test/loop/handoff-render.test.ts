import { describe, expect, it } from 'vitest'
import {
  renderCodeHandoff,
  renderExternalReviewHandoff,
  renderPlanHandoff,
  renderReviewHandoff,
  renderVerifyHandoff,
} from '../../src/loop/handoff-render.js'
import type { CoderOutput, PlannerOutput, ReviewerOutput, VerifyResult } from '../../src/workers/types.js'

describe('handoff renderers', () => {
  it('renders a planner output into a concise handoff payload', () => {
    const plan: PlannerOutput = {
      objective: 'Fix checkout flow',
      assumptions: ['Payment provider config is valid'],
      filesToChange: ['src/checkout.ts', 'test/checkout.test.ts'],
      steps: [
        { order: 1, description: 'Preserve cart items during payment retry', files: ['src/checkout.ts'] },
        { order: 2, description: 'Cover the retry path', files: ['test/checkout.test.ts'] },
      ],
      risks: ['Retry state may affect existing abandoned-cart metrics'],
      testStrategy: 'Run checkout unit tests and a focused integration test',
    }

    const handoff = renderPlanHandoff(plan)

    expect(handoff).toEqual({
      summary: 'Plan: Fix checkout flow (2 steps, 2 files)',
      contentMd: [
        '## Plan',
        '',
        'Objective: Fix checkout flow',
        '',
        'Assumptions:',
        '- Payment provider config is valid',
        '',
        'Files to change:',
        '- src/checkout.ts',
        '- test/checkout.test.ts',
        '',
        'Steps:',
        '1. Preserve cart items during payment retry',
        '   Files: src/checkout.ts',
        '2. Cover the retry path',
        '   Files: test/checkout.test.ts',
        '',
        'Risks:',
        '- Retry state may affect existing abandoned-cart metrics',
        '',
        'Test strategy:',
        'Run checkout unit tests and a focused integration test',
      ].join('\n'),
      contentJson: plan,
    })
  })

  it('renders a coder output into a concise handoff payload', () => {
    const code: CoderOutput = {
      summary: 'Preserved cart items during payment retry',
      changedFiles: ['src/checkout.ts', 'test/checkout.test.ts'],
      remainingUncertainty: 'Need manual checkout smoke test',
      blockers: null,
    }

    const handoff = renderCodeHandoff(code)

    expect(handoff).toEqual({
      summary: 'Code: Preserved cart items during payment retry (2 files)',
      contentMd: [
        '## Code Summary',
        '',
        'Preserved cart items during payment retry',
        '',
        'Changed files:',
        '- src/checkout.ts',
        '- test/checkout.test.ts',
        '',
        'Remaining uncertainty:',
        'Need manual checkout smoke test',
      ].join('\n'),
      contentJson: code,
    })
  })

  it('renders a reviewer output into sanitized findings markdown', () => {
    const review: ReviewerOutput = {
      verdict: 'CHANGES_REQUIRED',
      summary: 'Found a retry regression in [checkout](https://example.test)',
      findings: [
        {
          severity: 'major',
          message: 'Cart is cleared after retry <script>alert(1)</script>',
          suggestedFix: 'Keep the existing cart snapshot',
        },
      ],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: true,
        noBlockingFindings: false,
      },
    }

    const handoff = renderReviewHandoff(review, 'review')

    expect(handoff).toEqual({
      summary: 'Review: CHANGES_REQUIRED (1 finding)',
      contentMd: [
        '## Review Findings: review',
        '',
        'Verdict: CHANGES_REQUIRED',
        '',
        'Found a retry regression in checkout [link removed]',
        '',
        'Findings:',
        '- [major] Cart is cleared after retry alert(1)',
        '  Suggested fix: Keep the existing cart snapshot',
        '',
        'Definition of done:',
        '- Issue addressed: no',
        '- Tests passing: yes',
        '- No blocking findings: no',
      ].join('\n'),
      contentJson: review,
    })
  })

  it('renders verify results into a pass/fail handoff summary', () => {
    const verifyResults: VerifyResult[] = [
      {
        command: 'pnpm test',
        exitCode: 0,
        stdout: 'all tests passed',
        stderr: '',
        durationMs: 1200,
        passed: true,
        required: true,
        stageId: 'unit',
      },
      {
        command: 'pnpm lint',
        exitCode: 1,
        stdout: '',
        stderr: 'src/file.ts:1:1 lint error',
        durationMs: 750,
        passed: false,
        required: true,
        stageId: 'lint',
      },
    ]

    const handoff = renderVerifyHandoff(verifyResults)

    expect(handoff).toEqual({
      summary: 'Verify: 1/2 passed',
      contentMd: [
        '## Verify Summary',
        '',
        'Passed: 1/2',
        '',
        '1. pnpm test',
        '   Stage: unit',
        '   Status: passed',
        '   Required: yes',
        '   Exit code: 0',
        '   Duration: 1200ms',
        '   stdout: all tests passed',
        '',
        '2. pnpm lint',
        '   Stage: lint',
        '   Status: failed',
        '   Required: yes',
        '   Exit code: 1',
        '   Duration: 750ms',
        '   stderr: src/file.ts:1:1 lint error',
      ].join('\n'),
      contentJson: verifyResults,
    })
  })

  it('renders an external reviewer output using the existing post-publish summary contract', () => {
    const review: ReviewerOutput = {
      verdict: 'CHANGES_REQUIRED',
      summary: 'CodeRabbit found a missing null guard',
      findings: [
        {
          severity: 'major',
          message: 'Add a null guard before reading config.name',
          suggestedFix: null,
        },
      ],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: true,
        noBlockingFindings: false,
      },
    }

    const handoff = renderExternalReviewHandoff(review, 'cr')

    expect(handoff).toEqual({
      summary: 'CHANGES_REQUIRED: 1 finding',
      contentMd: [
        '## External Review: cr',
        '',
        'Verdict: CHANGES_REQUIRED',
        '',
        'CodeRabbit found a missing null guard',
        '',
        'Findings:',
        '- [major] Add a null guard before reading config.name',
      ].join('\n'),
      contentJson: review,
    })
  })
})
