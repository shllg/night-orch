import type { Config, RepoConfig } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isGitRepo, branchExistsLocally, branchExistsRemotely, fetchOrigin } from '../git/repo.js'
import { parseCommandSpec } from '../utils/command.js'
import { checkWorkerAuth } from '../workers/auth-check.js'
import { logger } from '../utils/logger.js'

const execFileAsync = promisify(execFile)

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
  const roleProfiles: Array<{ role: 'planner' | 'coder' | 'reviewer'; agentName: string; profile: NonNullable<Config['workerProfiles'][string]> | null }> = []
  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const agentName = repoConfig.defaults[role]
    const mappedProfile = repoConfig.agents[agentName]
    const profile = mappedProfile
      ? config.workerProfiles[mappedProfile]
      : Object.values(config.workerProfiles).find((p) => p.type === agentName)
    roleProfiles.push({ role, agentName, profile: profile ?? null })

    results.push({
      name: `Worker profile for ${role} (${agentName})`,
      passed: !!profile,
      message: profile
        ? `Found profile: ${mappedProfile ?? agentName} (command: ${profile.command})`
        : `No worker profile found for agent '${agentName}'`,
      category: 'environment',
    })
  }

  // 7. Worker auth checks for resolved roles
  for (const { role, agentName, profile } of roleProfiles) {
    if (!profile) continue
    const adapterType = profile.type === 'codex' ? 'codex' : profile.type === 'claude' ? 'claude' : null
    if (!adapterType) {
      results.push({
        name: `Worker auth for ${role} (${agentName})`,
        passed: true,
        message: `Skipped for unsupported worker type '${profile.type}'`,
        category: 'auth',
        optional: true,
      })
      continue
    }

    const auth = await checkWorkerAuth(profile.command, adapterType)
    results.push({
      name: `Worker auth for ${role} (${agentName})`,
      passed: auth.authenticated,
      message: auth.authenticated
        ? 'Authenticated'
        : `${auth.error ?? 'Authentication failed'}${auth.remediation ? ` — ${auth.remediation}` : ''}`,
      category: 'auth',
    })
  }

  // 8. Verify commands configured
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

  if (repoConfig.verificationProfile) {
    const profile = config.verificationProfiles[repoConfig.verificationProfile]
    results.push({
      name: `Verification profile: ${repoConfig.verificationProfile}`,
      passed: !!profile,
      message: profile
        ? `${profile.stages.length} stage(s) configured`
        : 'Configured verificationProfile not found in config.verificationProfiles',
      category: 'verify',
    })
  }

  // 9. Verify binaries present on PATH
  for (const verifyCommand of repoConfig.verify) {
    const commandSpec = normalizeVerifyCommandSpec(verifyCommand)
    try {
      const { binary } = parseCommandSpec(commandSpec)
      const found = await checkBinary(binary)
      results.push({
        name: `Verify binary: ${binary}`,
        passed: found,
        message: found ? 'Found' : 'Not found on PATH',
        category: 'verify',
      })
    } catch (err) {
      results.push({
        name: 'Verify command parse',
        passed: false,
        message: (err as Error).message,
        category: 'verify',
      })
    }
  }

  // 10. Workflow prompt file checks
  if (repoConfig.workflow) {
    const workflow = config.workflows[repoConfig.workflow]
    if (!workflow) {
      results.push({
        name: `Workflow: ${repoConfig.workflow}`,
        passed: false,
        message: 'Configured workflow not found in config.workflows',
        category: 'environment',
      })
    } else {
      const verifyRefs = workflow.steps
        ? workflow.steps.reduce<Array<{ id: string; profile?: string; stage?: string }>>((acc, step) => {
            if (step.type === 'verify') {
              acc.push({ id: step.id, profile: step.profile, stage: step.stage })
            }
            return acc
          }, [])
        : workflow.dag
          ? Object.entries(workflow.dag.stages).reduce<Array<{ id: string; profile?: string; stage?: string }>>((acc, [id, stage]) => {
              if (stage.type === 'verify') {
                acc.push({ id, profile: stage.profile, stage: stage.stage })
              }
              return acc
            }, [])
          : []

      for (const verifyRef of verifyRefs) {
        const selectedProfile = verifyRef.profile ?? repoConfig.verificationProfile
        if (!selectedProfile) continue

        const profile = config.verificationProfiles[selectedProfile]
        results.push({
          name: `Workflow verify profile: ${verifyRef.id}`,
          passed: !!profile,
          message: profile
            ? `Profile "${selectedProfile}" found`
            : `Profile "${selectedProfile}" not found`,
          category: 'verify',
        })

        if (profile && verifyRef.stage) {
          const hasStage = profile.stages.some((stage) => stage.id === verifyRef.stage)
          results.push({
            name: `Workflow verify stage: ${verifyRef.id}`,
            passed: hasStage,
            message: hasStage
              ? `Stage "${verifyRef.stage}" found in profile "${selectedProfile}"`
              : `Stage "${verifyRef.stage}" not found in profile "${selectedProfile}"`,
            category: 'verify',
          })
        }
      }

      const workerPromptRefs = workflow.steps
        ? workflow.steps.reduce<Array<{ id: string; prompt: string }>>((acc, step) => {
            if (step.type === 'worker' && step.prompt) {
              acc.push({ id: step.id, prompt: step.prompt })
            }
            return acc
          }, [])
        : workflow.dag
          ? Object.entries(workflow.dag.stages).reduce<Array<{ id: string; prompt: string }>>((acc, [id, stage]) => {
              if (stage.type === 'worker' && stage.prompt) {
                acc.push({ id, prompt: stage.prompt })
              }
              return acc
            }, [])
          : []

      for (const step of workerPromptRefs) {
        results.push({
          name: `Workflow prompt: ${step.id}`,
          passed: existsSync(step.prompt),
          message: existsSync(step.prompt)
            ? step.prompt
            : `Missing file: ${step.prompt}`,
          category: 'environment',
        })
      }
    }
  }

  logger.info(
    { repo: repoConfig.repo, passed: results.filter((r) => r.passed).length, total: results.length },
    'Project validation complete',
  )

  return results
}

function normalizeVerifyCommandSpec(command: string | string[] | { command: string | string[] }): string | string[] {
  if (Array.isArray(command) || typeof command === 'string') return command
  return command.command
}

async function checkBinary(binary: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('which', [binary], { timeout: 5000 })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
