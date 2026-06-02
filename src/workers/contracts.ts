import { z } from 'zod'
import type { CoderOutput, PlannerOutput, ReviewerOutput, VerifyResult } from './types.js'

export const PlannerOutputContractSchema: z.ZodType<PlannerOutput> = z.object({
  objective: z.string(),
  assumptions: z.array(z.string()),
  filesToChange: z.array(z.string()),
  steps: z.array(z.object({
    order: z.number(),
    description: z.string(),
    files: z.array(z.string()),
  })),
  risks: z.array(z.string()),
  testStrategy: z.string(),
})

export const CoderOutputContractSchema: z.ZodType<CoderOutput> = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  remainingUncertainty: z.string().nullable(),
  blockers: z.array(z.string()).nullable(),
})

export const ReviewerOutputContractSchema: z.ZodType<ReviewerOutput> = z.object({
  verdict: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED']),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      message: z.string(),
      suggestedFix: z.string().nullable(),
    }),
  ),
  definitionOfDoneCheck: z.object({
    issueAddressed: z.boolean(),
    testsPassing: z.boolean(),
    noBlockingFindings: z.boolean(),
  }),
})

export const VerifyResultContractSchema: z.ZodType<VerifyResult> = z.object({
  command: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  passed: z.boolean(),
  required: z.boolean().optional(),
  stageId: z.string().nullable().optional(),
  onFailure: z.enum(['block', 'iterate', 'warn']).optional(),
})

export const VerifyResultsContractSchema: z.ZodType<VerifyResult[]> = z.array(VerifyResultContractSchema)
