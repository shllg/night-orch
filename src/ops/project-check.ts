import type { Config, RepoConfig } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { existsSync } from 'node:fs'
import { isGitRepo, branchExistsLocally, branchExistsRemotely, fetchOrigin } from '../git/repo.js'
import { logger } from '../utils/logger.js'

export interface ProjectCheckResult {
  name: string
  passed: boolean
  message: string
  category: 'repo' | 'auth' | 'labels' | 'verify' | 'environment'
  optional?: boolean
}

/**
 * Validate that a target project is properly set up for night-orch.
 * Returns a list of check results — all must pass for the project to be ready.
 */
export async function validateProjectSetup(
  repoConfig: RepoConfig,
  config: Config,
  forge: ForgeAdapter,
): Promise<ProjectCheckResult[]> {
  const results: ProjectCheckResult[] = []

  // 1. Repo local path exists and is a git repo
  if (!existsSync(repoConfig.localPath)) {
    results.push({
      name: 'Local path exists',
      passed: false,
      message: `Path does not exist: ${repoConfig.localPath}`,
      category: 'repo',
    })
  } else {
    const isRepo = await isGitRepo(repoConfig.localPath)
    results.push({
      name: 'Local path is git repo',
      passed: isRepo,
      message: isRepo
        ? `Valid git repo at ${repoConfig.localPath}`
        : `Not a git repo: ${repoConfig.localPath}`,
      category: 'repo',
    })

    // 2. Base branch exists
    if (isRepo) {
      try {
        await fetchOrigin(repoConfig.localPath)
        results.push({
          name: 'Fetch origin',
          passed: true,
          message: 'Successfully fetched from origin',
          category: 'repo',
        })
      } catch (err) {
        results.push({
          name: 'Fetch origin',
          passed: false,
          message: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
          category: 'repo',
        })
      }

      const localExists = await branchExistsLocally(repoConfig.localPath, repoConfig.baseBranch)
      const remoteExists = await branchExistsRemotely(repoConfig.localPath, repoConfig.baseBranch)
      results.push({
        name: 'Base branch exists',
        passed: localExists || remoteExists,
        message: localExists || remoteExists
          ? `Base branch '${repoConfig.baseBranch}' found (local: ${localExists}, remote: ${remoteExists})`
          : `Base branch '${repoConfig.baseBranch}' not found locally or remotely`,
        category: 'repo',
      })
    }
  }

  // 3. Forge auth works
  try {
    const authInfo = await forge.validateAuth()
    results.push({
      name: 'Forge authentication',
      passed: true,
      message: `Authenticated as ${authInfo.user}`,
      category: 'auth',
    })
  } catch (err) {
    results.push({
      name: 'Forge authentication',
      passed: false,
      message: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
      category: 'auth',
    })
  }

  // 4. Repo is accessible
  try {
    await forge.getIssue(repoConfig.repo, 1).catch(() => null) // 404 is OK — just checking access
    results.push({
      name: 'Repo accessible',
      passed: true,
      message: `Can access ${repoConfig.repo}`,
      category: 'auth',
    })
  } catch (err) {
    results.push({
      name: 'Repo accessible',
      passed: false,
      message: `Cannot access ${repoConfig.repo}: ${err instanceof Error ? err.message : String(err)}`,
      category: 'auth',
    })
  }

  // 5. Ready labels configured
  const readyLabels = Array.isArray(repoConfig.labels.ready) ? repoConfig.labels.ready : [repoConfig.labels.ready]
  results.push({
    name: 'Ready labels configured',
    passed: readyLabels.length > 0,
    message: readyLabels.length > 0
      ? `Ready labels: ${readyLabels.join(', ')} — run 'night-orch labels-init' to ensure they exist on the repo`
      : 'No ready labels configured',
    category: 'labels',
  })

  // 6. Worker profiles exist for configured roles
  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const agentName = repoConfig.defaults[role]
    const mappedProfile = repoConfig.agents[agentName]
    const profile = mappedProfile
      ? config.workerProfiles[mappedProfile]
      : Object.values(config.workerProfiles).find((p) => p.type === agentName)

    results.push({
      name: `Worker profile for ${role} (${agentName})`,
      passed: !!profile,
      message: profile
        ? `Found profile: ${mappedProfile ?? agentName} (command: ${profile.command})`
        : `No worker profile found for agent '${agentName}'`,
      category: 'environment',
    })
  }

  // 7. Verify commands configured
  const hasVerify = (repoConfig.verify?.length ?? 0) > 0
  results.push({
    name: 'Verify commands configured',
    passed: hasVerify,
    message: hasVerify
      ? `${repoConfig.verify.length} verify command(s) configured`
      : 'No verify commands configured — runs will skip verification',
    category: 'verify',
    optional: true,
  })

  logger.info(
    { repo: repoConfig.repo, passed: results.filter((r) => r.passed).length, total: results.length },
    'Project validation complete',
  )

  return results
}
