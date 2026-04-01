import { describe, it, expect } from 'vitest'
import { topologicalWaves } from '../../src/loop/parallel.js'
import type { SubTask } from '../../src/workers/parsers/decomposer.js'

describe('topologicalWaves', () => {
  it('groups independent tasks into one wave', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [], estimatedComplexity: 'standard' },
    ]
    const waves = topologicalWaves(tasks)
    expect(waves).toHaveLength(1)
    expect(waves[0]).toEqual([0, 1, 2])
  })

  it('respects dependency ordering', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [0], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [1], estimatedComplexity: 'standard' },
    ]
    const waves = topologicalWaves(tasks)
    expect(waves).toHaveLength(3)
    expect(waves[0]).toEqual([0])
    expect(waves[1]).toEqual([1])
    expect(waves[2]).toEqual([2])
  })

  it('groups same-depth dependencies into same wave', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [0, 1], estimatedComplexity: 'standard' },
    ]
    const waves = topologicalWaves(tasks)
    expect(waves).toHaveLength(2)
    expect(waves[0]).toEqual([0, 1])
    expect(waves[1]).toEqual([2])
  })

  it('handles empty input', () => {
    expect(topologicalWaves([])).toEqual([])
  })

  it('throws on cyclic dependencies', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [1], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [0], estimatedComplexity: 'standard' },
    ]
    expect(() => topologicalWaves(tasks)).toThrow('Cyclic subtask dependencies detected')
  })
})
