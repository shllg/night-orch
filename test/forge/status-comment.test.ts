import { describe, it, expect } from 'vitest'
import { formatStatusComment } from '../../src/forge/status-comment.js'

describe('formatStatusComment', () => {
  it('renders blocked status', () => {
    const result = formatStatusComment({
      blockReason: 'Per-run cost limit exceeded',
      iteration: 3,
      maxIterations: 4,
      cost: 5.1234,
    })
    expect(result).toContain('**Status:** Blocked')
    expect(result).toContain('Per-run cost limit exceeded')
    expect(result).toContain('**Iteration:** 3/4')
    expect(result).toContain('**Cost:** $5.1234')
  })

  it('separates fields with blank lines so GitHub renders distinct lines, not one paragraph', () => {
    const result = formatStatusComment({
      blockReason: 'Reviewer blocked: tests failing',
      iteration: 1,
      maxIterations: 3,
      cost: 1,
    })
    // Adjacent fields must be separated by a blank line (\n\n), otherwise
    // GitHub-flavored markdown collapses them into a single paragraph.
    expect(result).toContain('**Status:** Blocked\n\n**Reason:** Reviewer blocked: tests failing')
    expect(result).toContain('**Reason:** Reviewer blocked: tests failing\n\n**Iteration:** 1/3')
    expect(result).not.toMatch(/\*\*Status:\*\* Blocked\n\*\*Reason/) // no single-newline join
  })

  it('renders real and metered cost when theoreticalCost is provided', () => {
    const result = formatStatusComment({
      phase: 'code',
      cost: 0,
      theoreticalCost: 4.2,
    })
    expect(result).toContain('**Cost:** $0.0000 real / $4.2000 metered')
  })

  it('renders error status', () => {
    const result = formatStatusComment({
      error: 'Worker timeout',
      retryCount: 2,
      maxRetries: 3,
      nextStep: 'Automatic retry queued.',
    })
    expect(result).toContain('**Status:** Error')
    expect(result).toContain('Worker timeout')
    expect(result).toContain('**Retries:** 2/3')
    expect(result).toContain('**Next:** Automatic retry queued.')
  })

  it('renders PR ready status', () => {
    const result = formatStatusComment({
      prUrl: 'https://github.com/org/repo/pull/42',
    })
    expect(result).toContain('**Status:** PR Ready')
    expect(result).toContain('https://github.com/org/repo/pull/42')
  })

  it('renders running status with phase', () => {
    const result = formatStatusComment({ phase: 'code' })
    expect(result).toContain('**Status:** Running (code)')
  })

  it('collapses plan in details block', () => {
    const result = formatStatusComment({
      phase: 'plan',
      plan: '1. Read issue\n2. Write code',
    })
    expect(result).toContain('<details><summary>Plan summary</summary>')
    expect(result).toContain('1. Read issue')
    expect(result).toContain('</details>')
  })

  it('renders empty when no sections', () => {
    const result = formatStatusComment({})
    expect(result).toBe('')
  })
})
