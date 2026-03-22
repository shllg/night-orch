import { describe, it, expect } from 'vitest'
import { parseCommandSpec, parseCommandString } from '../../src/utils/command.js'

describe('parseCommandString', () => {
  it('parses simple commands', () => {
    expect(parseCommandString('pnpm test')).toEqual({
      binary: 'pnpm',
      args: ['test'],
    })
  })

  it('handles quoted arguments with spaces', () => {
    expect(parseCommandString('echo "hello world"')).toEqual({
      binary: 'echo',
      args: ['hello world'],
    })
  })

  it('handles single quotes', () => {
    expect(parseCommandString("node -e 'console.log(1)'")).toEqual({
      binary: 'node',
      args: ['-e', 'console.log(1)'],
    })
  })

  it('throws on unterminated quotes', () => {
    expect(() => parseCommandString('echo "oops')).toThrow('Unterminated')
  })
})

describe('parseCommandSpec', () => {
  it('passes through command arrays', () => {
    expect(parseCommandSpec(['pnpm', 'lint'])).toEqual({
      binary: 'pnpm',
      args: ['lint'],
    })
  })

  it('throws on empty command arrays', () => {
    expect(() => parseCommandSpec([])).toThrow('must contain at least one')
  })
})
