import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToString } from 'ink'
import { ConfigSchema, type RepoConfig } from '../../../src/config/schema.js'
import { ProjectsView, resolveProjectSelectionIndex, resolveRepoAuthDisplay } from '../../../src/cli/tui/projects-view.js'

function makeRepo(overrides: Partial<RepoConfig>): RepoConfig {
  const config = ConfigSchema.parse({
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN' },
    repos: [
      {
        repo: 'acme/service',
        localPath: '/tmp/acme-service',
        ...overrides,
      },
    ],
  })
  return config.repos[0]!
}

describe('projects view helpers', () => {
  it('returns -1 for empty repo list and clamps out-of-range indices', () => {
    expect(resolveProjectSelectionIndex(0, 0)).toBe(-1)
    expect(resolveProjectSelectionIndex(-4, 3)).toBe(0)
    expect(resolveProjectSelectionIndex(99, 3)).toBe(2)
  })

  it('selects the expected repo after index clamping', () => {
    const repos = [
      makeRepo({ repo: 'org/alpha' }),
      makeRepo({ repo: 'org/beta' }),
    ]

    const index = resolveProjectSelectionIndex(7, repos.length)
    expect(repos[index]?.repo).toBe('org/beta')
  })

  it('uses global github fallbacks for github repos', () => {
    const repo = makeRepo({
      forge: 'github',
      tokenEnv: undefined,
      apiBaseUrl: undefined,
    })

    const auth = resolveRepoAuthDisplay(repo, {
      githubTokenEnv: 'GH_TOKEN',
      githubApiBaseUrl: 'https://api.github.example',
    })

    expect(auth.tokenEnv).toBe('GH_TOKEN (global github.tokenEnv)')
    expect(auth.apiBaseUrl).toBe('https://api.github.example (global github.apiBaseUrl)')
    expect(auth.apiMissing).toBe(false)
  })

  it('uses forgejo defaults and marks missing apiBaseUrl as required', () => {
    const repo = makeRepo({
      forge: 'forgejo',
      tokenEnv: undefined,
      apiBaseUrl: undefined,
    })

    const auth = resolveRepoAuthDisplay(repo, {
      githubTokenEnv: 'GH_TOKEN',
      githubApiBaseUrl: 'https://api.github.example',
    })

    expect(auth.tokenEnv).toBe('FORGEJO_TOKEN (default)')
    expect(auth.apiBaseUrl).toBe('(missing: required for forgejo)')
    expect(auth.apiMissing).toBe(true)
  })

  it('uses explicit forgejo token and api values when configured', () => {
    const repo = makeRepo({
      forge: 'forgejo',
      tokenEnv: 'CUSTOM_FORGEJO_TOKEN',
      apiBaseUrl: 'https://forgejo.example/api/v1',
    })

    const auth = resolveRepoAuthDisplay(repo, {
      githubTokenEnv: 'GH_TOKEN',
      githubApiBaseUrl: 'https://api.github.example',
    })

    expect(auth.tokenEnv).toBe('CUSTOM_FORGEJO_TOKEN')
    expect(auth.apiBaseUrl).toBe('https://forgejo.example/api/v1')
    expect(auth.apiMissing).toBe(false)
  })

  it('renders empty project state', () => {
    const output = renderToString(React.createElement(ProjectsView, {
      repos: [],
      selectedIndex: 0,
      workerProfiles: {},
      globalGithubTokenEnv: 'GH_TOKEN',
      globalGithubApiBaseUrl: 'https://api.github.example',
    }))

    expect(output).toContain('Projects (0)')
    expect(output).toContain('No configured repositories')
    expect(output).toContain('Select a repository to inspect')
  })

  it('renders forge-aware auth defaults for selected forgejo repo', () => {
    const output = renderToString(React.createElement(ProjectsView, {
      repos: [makeRepo({ repo: 'org/forgejo-repo', forge: 'forgejo', tokenEnv: undefined, apiBaseUrl: undefined })],
      selectedIndex: 0,
      workerProfiles: {},
      globalGithubTokenEnv: 'GH_TOKEN',
      globalGithubApiBaseUrl: 'https://api.github.example',
    }))

    expect(output).toContain('org/forgejo-repo')
    expect(output).toContain('token FORGEJO_TOKEN (default)')
    expect(output).toContain('api (missing: required for forgejo)')
    expect(output).toContain('apiBaseUrl is required for Forgejo')
  })

  it('renders github global auth defaults for selected github repo', () => {
    const output = renderToString(React.createElement(ProjectsView, {
      repos: [makeRepo({ repo: 'org/github-repo', forge: 'github', tokenEnv: undefined, apiBaseUrl: undefined })],
      selectedIndex: 0,
      workerProfiles: {},
      globalGithubTokenEnv: 'GH_TOKEN',
      globalGithubApiBaseUrl: 'https://api.github.example',
    }))

    expect(output).toContain('org/github-repo')
    expect(output).toContain('token GH_TOKEN (global')
    expect(output).toContain('github.tokenEnv)')
    expect(output).toContain('https://api.github.example (global')
    expect(output).toContain('github.apiBaseUrl)')
  })
})
