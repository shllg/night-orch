import { parseJsonFromOutput } from './extract.js'
import { z } from 'zod'

export interface SubTask {
  title: string
  description: string
  dependencies: number[]
  estimatedComplexity: 'trivial' | 'standard'
}

export interface DecompositionResult {
  shouldDecompose: boolean
  subtasks: SubTask[]
  reasoning: string
}

const SubTaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  dependencies: z.array(z.number().int().min(0)).default([]),
  estimatedComplexity: z.enum(['trivial', 'standard']).default('standard'),
}).passthrough()

const DecompositionSchema = z.object({
  shouldDecompose: z.boolean(),
  reasoning: z.string().default(''),
  subtasks: z.array(SubTaskSchema).default([]),
}).passthrough()

export function parseDecomposerOutput(
  raw: string,
  maxSubtasks = 5,
): { result: DecompositionResult | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return {
      result: { shouldDecompose: false, subtasks: [], reasoning: '' },
      error: 'No JSON found in decomposer output — fallback to no decomposition',
    }
  }

  const validation = DecompositionSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      result: { shouldDecompose: false, subtasks: [], reasoning: '' },
      error: `Decomposer output failed validation — fallback to no decomposition`,
    }
  }

  const result = validation.data
  if (result.subtasks.length > maxSubtasks) {
    result.subtasks = result.subtasks.slice(0, maxSubtasks)
  }

  return { result, error: null }
}
