import { describe, expect, it } from 'vitest'
import {
  applyWorkflowAgentOverrides,
  applyWorkflowRoleDefaults,
  resolveWorkerProfileForAgent,
} from '../../src/runner/workflow-overlay.js'
import { makeTestConfig } from '../helpers/factories.js'

describe('workflow overlay helpers', () => {
  it('merges workflow agent mappings over repo agent mappings', () => {
    const config = makeTestConfig({
      repos: [{
        agents: { claude: 'claude-default' },
      }],
    })
    const repoConfig = config.repos[0]!

    const overlaid = applyWorkflowAgentOverrides(repoConfig, {
      steps: [{ type: 'worker', id: 'code', role: 'coder' }],
      agents: { codex: 'codex-fast' },
    })

    expect(overlaid.agents).toEqual({
      claude: 'claude-default',
      codex: 'codex-fast',
    })
    expect(repoConfig.agents).toEqual({ claude: 'claude-default' })
  })

  it('keeps workflow role defaults only when the agent can resolve to a worker profile', () => {
    const config = makeTestConfig({
      workerProfiles: {
        claude: { type: 'claude', command: 'claude' },
        'codex-fast': { type: 'codex', command: 'codex' },
      },
      repos: [{
        defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
        agents: { codex: 'codex-fast' },
      }],
    })
    const repoConfig = config.repos[0]!

    const defaults = applyWorkflowRoleDefaults(
      repoConfig.defaults,
      { steps: [{ type: 'worker', id: 'code', role: 'coder' }], roles: { coder: 'codex', reviewer: 'opencode' } },
      repoConfig,
      config,
    )

    expect(defaults).toMatchObject({
      planner: 'claude',
      coder: 'codex',
      reviewer: 'claude',
    })
  })

  it('resolves mapped profiles before falling back to profile type', () => {
    const config = makeTestConfig({
      workerProfiles: {
        claude: { type: 'claude', command: 'claude' },
        'codex-fast': { type: 'codex', command: 'codex' },
      },
      repos: [{
        agents: { codex: 'codex-fast' },
      }],
    })
    const repoConfig = config.repos[0]!

    expect(resolveWorkerProfileForAgent('codex', repoConfig, config)).toBe(config.workerProfiles['codex-fast'])
    expect(resolveWorkerProfileForAgent('claude', repoConfig, config)).toBe(config.workerProfiles.claude)
  })
})
