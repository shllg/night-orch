import type { MCPDependencies } from '../mcp/server.js'
import {
  sanitizeProjectRepo,
  sanitizeWorkerProfile,
  type ProjectRepoSummary,
  type ProjectWorkerProfileSummary,
} from '../config/sanitize.js'
import { handleToolCall } from '../mcp/tools/index.js'
import { loadTuiStats, type RuntimeStatsSnapshot } from '../state/stats.js'
import { getBuildInfo } from '../utils/build-info.js'
import { nowUtcIso } from '../utils/time.js'
import {
  listRuntimeSettings,
  resolveConfigWithRuntimeSettings,
  type RuntimeSettingSnapshot,
} from '../settings/runtime.js'
import {
  getSettingDefinition,
  resolveSettingYamlValue,
  sanitizeSettingValueForDisplay,
  type SettingValue,
} from '../settings/registry.js'

interface DashboardSnapshot {
  generatedAt: string
  status: unknown
  runs: unknown
  inbox: unknown
  cost: unknown
  build: {
    version: string
    gitSha: string | null
    installMethod: 'git' | 'npm' | 'unknown'
  }
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: RuntimeStatsSnapshot
}

interface SettingsSnapshot {
  generatedAt: string
  settings: SettingsSnapshotEntry[]
}

interface SettingsSnapshotEntry extends RuntimeSettingSnapshot {
  hasYamlValue: boolean
  yamlValue: SettingValue | null
}

interface ProjectsSnapshot {
  generatedAt: string
  githubDefaults: {
    tokenEnv: string
    apiBaseUrl: string
  }
  workerProfiles: Record<string, ProjectWorkerProfileSummary>
  repos: ProjectRepoSummary[]
}

const BUILD_INFO = getBuildInfo()

export async function buildDashboardSnapshot(deps: MCPDependencies): Promise<DashboardSnapshot> {
  const runtimeConfig = resolveConfigWithRuntimeSettings(deps.config, deps.db)
  const runtimeDeps: MCPDependencies = {
    ...deps,
    config: runtimeConfig,
  }

  const [status, runs, inbox, cost] = await Promise.all([
    handleToolCall('night-orch-status', {}, runtimeDeps),
    handleToolCall('night-orch-list-runs', { limit: 100 }, runtimeDeps),
    handleToolCall('night-orch-list-inbox', { limit: 100 }, runtimeDeps),
    handleToolCall('night-orch-cost-report', { days: 7 }, runtimeDeps),
  ])

  return {
    generatedAt: nowUtcIso(),
    status,
    runs,
    inbox,
    cost,
    build: BUILD_INFO,
    config: {
      repos: runtimeConfig.repos.map((repo) => repo.repo),
      pollIntervalSeconds: runtimeConfig.github.pollIntervalSeconds,
    },
    stats: loadTuiStats(runtimeDeps.db, { costModel: runtimeConfig.cost.model }),
  }
}

export function buildProjectsSnapshot(deps: MCPDependencies): ProjectsSnapshot {
  return {
    generatedAt: nowUtcIso(),
    githubDefaults: {
      tokenEnv: deps.config.github.tokenEnv,
      apiBaseUrl: deps.config.github.apiBaseUrl,
    },
    workerProfiles: Object.fromEntries(
      Object.entries(deps.config.workerProfiles).map(([name, profile]) => [
        name,
        sanitizeWorkerProfile(profile),
      ]),
    ),
    repos: deps.config.repos.map((repo) => sanitizeProjectRepo(repo)),
  }
}

export function buildSettingsSnapshot(deps: MCPDependencies, rawConfig: unknown): SettingsSnapshot {
  const runtimeSettings = listRuntimeSettings(deps.config, deps.db)

  return {
    generatedAt: nowUtcIso(),
    settings: runtimeSettings.map((setting) => {
      const definition = getSettingDefinition(setting.key)
      if (!definition) {
        return {
          ...setting,
          hasYamlValue: false,
          yamlValue: null,
        }
      }

      const { hasYamlValue, yamlValue } = resolveSettingYamlValue(definition, rawConfig, deps.config)
      return {
        ...setting,
        hasYamlValue,
        yamlValue: sanitizeSettingValueForDisplay(definition, yamlValue),
      }
    }),
  }
}
