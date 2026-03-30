import { describe, it, expect } from 'vitest'
import { parseDecomposerOutput } from '../../../src/workers/parsers/decomposer.js'

describe('parseDecomposerOutput', () => {
  it('parses valid decomposition with subtasks', () => {
    const raw = '```json\n' + JSON.stringify({
      shouldDecompose: true,
      reasoning: 'This issue has two independent parts',
      subtasks: [
        { title: 'Add API endpoint', description: 'Create /api/users', dependencies: [], estimatedComplexity: 'standard' },
        { title: 'Add tests', description: 'Test the endpoint', dependencies: [0], estimatedComplexity: 'trivial' },
      ],
    }) + '\n```'

    const { result, error } = parseDecomposerOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.shouldDecompose).toBe(true)
    expect(result!.subtasks).toHaveLength(2)
    expect(result!.subtasks[0]!.title).toBe('Add API endpoint')
    expect(result!.subtasks[1]!.dependencies).toEqual([0])
  })

  it('parses shouldDecompose=false', () => {
    const raw = '```json\n' + JSON.stringify({
      shouldDecompose: false,
      reasoning: 'This issue is already atomic',
      subtasks: [],
    }) + '\n```'

    const { result, error } = parseDecomposerOutput(raw)

    expect(error).toBeNull()
    expect(result!.shouldDecompose).toBe(false)
    expect(result!.subtasks).toEqual([])
  })

  it('falls back to no-decompose on parse failure', () => {
    const { result, error } = parseDecomposerOutput('Just some text')

    expect(result).not.toBeNull()
    expect(result!.shouldDecompose).toBe(false)
    expect(error).toContain('fallback')
  })

  it('caps subtasks at maxSubtasks', () => {
    const subtasks = Array.from({ length: 10 }, (_, i) => ({
      title: `Task ${i}`, description: `Desc ${i}`, dependencies: [], estimatedComplexity: 'standard',
    }))
    const raw = JSON.stringify({ shouldDecompose: true, reasoning: 'Many tasks', subtasks })

    const { result } = parseDecomposerOutput(raw, 5)

    expect(result!.subtasks).toHaveLength(5)
  })

  it('defaults estimatedComplexity to standard', () => {
    const raw = JSON.stringify({
      shouldDecompose: true,
      reasoning: 'Split it',
      subtasks: [{ title: 'A', description: 'B', dependencies: [] }],
    })

    const { result } = parseDecomposerOutput(raw)

    expect(result!.subtasks[0]!.estimatedComplexity).toBe('standard')
  })
})
