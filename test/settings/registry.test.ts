import { describe, it, expect } from 'vitest'
import { numberSetting } from '../../src/settings/registry.js'
import { makeTestConfig } from '../helpers/factories.js'

describe('settings registry', () => {
  it('re-validates config shape after applying a path mutation', () => {
    const baseConfig = makeTestConfig()
    const definition = numberSetting({
      key: 'test.loop.maxReviewIterations',
      label: 'Test max iterations',
      description: 'test',
      details: 'test',
      defaultValue: baseConfig.loop.maxReviewIterations,
      yamlPath: ['loop', 'maxReviewIterations'],
      integer: true,
      min: 1,
    })

    expect(() => {
      definition.apply(baseConfig, Number.NaN)
    }).toThrow()
  })
})
