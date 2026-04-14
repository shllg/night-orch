import { describe, expect, it } from 'vitest'
import { validateConflictResolution } from '../../src/ops/conflict-resolver-validate.js'

const source = {
  mergedWithMarkers: [
    'import { badge } from "./badge"',
    '<<<<<<< ours',
    'export function badge() {',
    '  return "ours"',
    '}',
    '=======',
    'export function badge() {',
    '  return "theirs"',
    '}',
    '>>>>>>> theirs',
    'export const stable = true',
  ].join('\n'),
  ours: [
    'import { badge } from "./badge"',
    'export function badge() {',
    '  return "ours"',
    '}',
    'export const stable = true',
  ].join('\n'),
  theirs: [
    'import { badge } from "./badge"',
    'export function badge() {',
    '  return "theirs"',
    '}',
    'export const stable = true',
  ].join('\n'),
}

describe('validateConflictResolution', () => {
  it('rejects output containing conflict markers', () => {
    const result = validateConflictResolution(source, '<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('conflict markers')
  })

  it('rejects empty output', () => {
    const result = validateConflictResolution(source, '   \n\n')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('empty')
  })

  it('rejects output that is too small', () => {
    const result = validateConflictResolution(source, 'x')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('safety floor')
  })

  it('rejects output that is too large', () => {
    const huge = `export function badge() {\n${'x'.repeat(200)}\n}`
    const result = validateConflictResolution(source, huge)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('safety ceiling')
  })

  it('rejects output that drops preserved lines', () => {
    const result = validateConflictResolution(source, [
      'export function badge() {',
      '  const explanation = "this stays long enough to clear the size floor"',
      '  return explanation',
      '}',
    ].join('\n'))
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('dropped preserved lines')
  })

  it('accepts a well-formed resolution', () => {
    const result = validateConflictResolution(source, [
      'import { badge } from "./badge"',
      'export function badge() {',
      '  return "main"',
      '}',
      'export const stable = true',
    ].join('\n'))
    expect(result.valid).toBe(true)
  })
})
