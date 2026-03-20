import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { expandPath } from '../../src/config/paths.js'
import { homedir } from 'node:os'

describe('expandPath', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env['TEST_VAR'] = '/custom/path'
    process.env['ANOTHER_VAR'] = 'value'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('expands ~ to home directory', () => {
    const result = expandPath('~/code/myrepo')
    expect(result).toBe(`${homedir()}/code/myrepo`)
  })

  it('expands bare ~', () => {
    const result = expandPath('~')
    expect(result).toBe(homedir())
  })

  it('expands $VAR syntax', () => {
    const result = expandPath('$TEST_VAR/sub')
    expect(result).toContain('/custom/path/sub')
  })

  it('expands ${VAR} syntax', () => {
    const result = expandPath('${TEST_VAR}/sub')
    expect(result).toContain('/custom/path/sub')
  })

  it('throws on undefined env var', () => {
    expect(() => expandPath('$UNDEFINED_VAR/sub')).toThrow(
      'Environment variable UNDEFINED_VAR is not set',
    )
  })

  it('resolves to absolute path', () => {
    const result = expandPath('relative/path')
    expect(result).toMatch(/^\//)
  })

  it('does not expand ~ in the middle of a path', () => {
    const result = expandPath('/some/~/path')
    expect(result).toContain('/some/~/path')
  })
})
