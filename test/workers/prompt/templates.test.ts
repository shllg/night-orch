import { describe, expect, it } from 'vitest'
import { DEFAULT_CODER_TEMPLATE } from '../../../src/workers/prompt/templates.js'

describe('DEFAULT_CODER_TEMPLATE', () => {
  it('requires root-cause and acceptance-criteria driven implementation output', () => {
    expect(DEFAULT_CODER_TEMPLATE).toContain('root cause')
    expect(DEFAULT_CODER_TEMPLATE).toContain('acceptance criteria')
    expect(DEFAULT_CODER_TEMPLATE).toContain('exact file changes')
    expect(DEFAULT_CODER_TEMPLATE).toContain('targeted tests')
    expect(DEFAULT_CODER_TEMPLATE).toContain('verification results')
    expect(DEFAULT_CODER_TEMPLATE).toContain('Do not only provide a plan')
  })
})
