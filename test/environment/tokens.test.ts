import { describe, it, expect } from 'vitest'
import {
  substituteTokens,
  substituteCommandTokens,
  substituteEnvTokens,
  defaultProjectName,
  findUnresolvedPortToken,
  unresolvedPortMessage,
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

  it('replaces named-pool {port:NAME} tokens and {port} as the first pool', () => {
    const named: RunTokens = {
      issue: 1, run: 'r', port: 5460,
      ports: { postgres: 5460, redis: 6460 }, project: 'p',
    }
    expect(substituteTokens('pg:{port:postgres} redis:{port:redis} def:{port}', named))
      .toBe('pg:5460 redis:6460 def:5460')
  })

  it('leaves an unknown {port:NAME} untouched (visible misconfig)', () => {
    const named: RunTokens = { issue: 1, run: 'r', port: 5460, ports: { postgres: 5460 }, project: 'p' }
    expect(substituteTokens('x:{port:rustfs}', named)).toBe('x:{port:rustfs}')
  })
})

describe('findUnresolvedPortToken', () => {
  it('returns null when all port tokens are resolved', () => {
    expect(findUnresolvedPortToken(['pg://localhost:5460', 'plain'])).toBeNull()
  })

  it('detects a bare {port} token', () => {
    expect(findUnresolvedPortToken(['x:{port}'])).toBe('{port}')
  })

  it('detects a named {port:NAME} token', () => {
    expect(findUnresolvedPortToken(['plain', 'x:{port:rustfs}'])).toBe('{port:rustfs}')
  })
})

describe('unresolvedPortMessage', () => {
  it('lists configured pools when some exist', () => {
    const msg = unresolvedPortMessage('{port:rustfs}', {
      issue: 1, run: 'r', port: 5460, ports: { postgres: 5460, redis: 6460 }, project: 'p',
    }, 'Verify command')
    expect(msg).toContain('{port:rustfs}')
    expect(msg).toContain('postgres, redis')
    expect(msg).toContain('Verify command')
  })

  it('says none configured when no pools exist', () => {
    const msg = unresolvedPortMessage('{port}', { issue: 1, run: 'r', project: 'p' }, 'Run hook')
    expect(msg).toContain('No `environment.ports` pool is configured')
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
