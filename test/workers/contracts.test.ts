import { describe, expect, it } from 'vitest'
import {
  CoderOutputContractSchema,
  PlannerOutputContractSchema,
  ReviewerOutputContractSchema,
} from '../../src/workers/contracts.js'

describe('worker output contracts', () => {
  it('accepts the planner, coder, and reviewer payloads consumed by the loop', () => {
    expect(PlannerOutputContractSchema.safeParse({
      objective: 'Fix resume',
      assumptions: [],
      filesToChange: ['src/loop/checkpoint.ts'],
      steps: [{ order: 1, description: 'Pin behavior', files: ['test/loop/checkpoint.test.ts'] }],
      risks: [],
      testStrategy: 'vitest',
    }).success).toBe(true)

    expect(CoderOutputContractSchema.safeParse({
      summary: 'Implemented',
      changedFiles: ['src/loop/checkpoint.ts'],
      remainingUncertainty: null,
      blockers: null,
    }).success).toBe(true)

    expect(ReviewerOutputContractSchema.safeParse({
      verdict: 'APPROVED',
      summary: 'Looks good',
      findings: [],
      definitionOfDoneCheck: {
        issueAddressed: true,
        testsPassing: true,
        noBlockingFindings: true,
      },
    }).success).toBe(true)
  })

  it('rejects reviewer output with unknown verdicts before the loop consumes it', () => {
    const parsed = ReviewerOutputContractSchema.safeParse({
      verdict: 'SHIP_IT',
      summary: 'Looks good',
      findings: [],
      definitionOfDoneCheck: {
        issueAddressed: true,
        testsPassing: true,
        noBlockingFindings: true,
      },
    })

    expect(parsed.success).toBe(false)
  })
})
