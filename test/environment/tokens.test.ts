import { describe, it, expect } from 'vitest'
import {
  substituteTokens,
  substituteCommandTokens,
  substituteEnvTokens,
  defaultProjectName,
  type RunTokens,
} from '../../src/environment/tokens.js'

const tokens: RunTokens = {
  issue: 341,
  run: 'abc123',
  port: 5460,
  project: 'dailywerk-341-abc123',
}

describe('substituteTokens', () => {
  it('replaces {issue}, {run}, {port}, {project}', () => {
    expect(
      substituteTokens('postgres://u:p@localhost:{port}/db_{run}_{issue}_{project}', tokens),
    ).toBe('postgres://u:p@localhost:5460/db_abc123_341_dailywerk-341-abc123')
  })

  it('replaces every occurrence of a token', () => {
    expect(substituteTokens('{issue}-{issue}', tokens)).toBe('341-341')
  })

  it('leaves {port} untouched when no port is allocated (visible misconfig)', () => {
    const noPort: RunTokens = { issue: 1, run: 'r', project: 'p' }
    expect(substituteTokens('x:{port}', noPort)).toBe('x:{port}')
  })
})

describe('substituteCommandTokens', () => {
  it('substitutes tokens in array-form commands', () => {
    expect(
      substituteCommandTokens(['docker', 'compose', '-p', '{project}', 'up'], tokens),
    ).toEqual(['docker', 'compose', '-p', 'dailywerk-341-abc123', 'up'])
  })

  it('substitutes tokens in string-form commands', () => {
    expect(substituteCommandTokens('docker -p {project} up', tokens))
      .toBe('docker -p dailywerk-341-abc123 up')
  })
})

describe('substituteEnvTokens', () => {
  it('substitutes tokens in env values', () => {
    expect(
      substituteEnvTokens({ DATABASE_URL: 'pg://localhost:{port}/{run}', RAILS_ENV: 'test' }, tokens),
    ).toEqual({ DATABASE_URL: 'pg://localhost:5460/abc123', RAILS_ENV: 'test' })
  })
})

describe('defaultProjectName', () => {
  it('combines sanitized repo slug, issue, and short run id', () => {
    expect(defaultProjectName('shllg/dailywerk', 341, 'run-3qn-n7k0KnJD')).toBe('dailywerk-341-3qn-n7k0knjd')
  })

  it('sanitizes unusual repo names to a docker-safe slug', () => {
    expect(defaultProjectName('My.Org/Weird Repo!', 7, 'run-AB')).toBe('weird-repo-7-ab')
  })
})
