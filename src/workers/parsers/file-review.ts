import { z } from 'zod'
import { parseJsonFromOutput } from './extract.js'
import type { FileReviewOutput } from '../../fileloop/types.js'

const FileReviewEditSchema = z.object({
  filePath: z.string().min(1),
  search: z.string(),
  replace: z.string(),
}).strict()

const FileReviewOutputSchema = z.object({
  summary: z.string().min(1),
  difficulty: z.enum(['trivial', 'moderate', 'complex']),
  refactorNotes: z.string().nullable().default(null),
  trivialFixes: z.array(FileReviewEditSchema).default([]),
}).strict()

export function parseFileReviewOutput(
  raw: string,
  expectedFilePath: string,
): { result: FileReviewOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { result: null, error: 'No JSON block found in file review output' }
  }

  const validation = FileReviewOutputSchema.safeParse(parsed)
  if (!validation.success) {
    const firstIssue = validation.error.issues[0]
    const path = firstIssue?.path.join('.') || 'root'
    return { result: null, error: `File review output failed validation at ${path}` }
  }

  for (const edit of validation.data.trivialFixes) {
    if (edit.filePath !== expectedFilePath) {
      return { result: null, error: `Edit targeted ${edit.filePath}; expected only ${expectedFilePath}` }
    }
  }

  return { result: validation.data, error: null }
}
