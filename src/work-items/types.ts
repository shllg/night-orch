import type { RepoConfig } from '../config/schema.js'
import type { TriageLevel } from '../discovery/triage.js'
import type { DiscoveredIssue } from '../discovery/discover.js'
import type { ResolvedWorkflow } from '../loop/workflow.js'

export interface WorkItem {
  id: string
  source: {
    kind: 'github-issue'
    repo: string
    number: number
    nodeId: string | null
    url: string
  }
  title: string
  body: string
  labels: string[]
  readiness: {
    triageLevel: TriageLevel
    includeLabels: string[]
  }
  acceptanceCriteria: string[]
  dependencies: number[]
  targetRepo: string
  workflow: {
    configuredName: string | null
    resolvedStepIds: string[]
  }
  verificationProfile: string | null
  runtime: {
    baseBranch: string
    branchPrefix: string
    maxConcurrentRuns: number
  }
  shiftTarget: string | null
}

export function createWorkItemFromDiscoveredIssue(
  discovered: DiscoveredIssue,
  repoConfig: RepoConfig,
  workflow: ResolvedWorkflow,
): WorkItem {
  const issue = discovered.issue
  const issueRepo = discovered.issueRepo || repoConfig.repo
  const criteria = extractAcceptanceCriteria(issue.body)
  const depMatches = Array.from(issue.body.matchAll(/\b(?:depends on|blocked by)\s+#(\d+)\b/gi))
  const dependencies = depMatches
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .filter((value) => Number.isInteger(value))

  return {
    id: `${issueRepo}#${issue.number}`,
    source: {
      kind: 'github-issue',
      repo: issueRepo,
      number: issue.number,
      nodeId: issue.nodeId,
      url: issue.url,
    },
    title: issue.title,
    body: issue.body,
    labels: [...issue.labels],
    readiness: {
      triageLevel: discovered.triage.level,
      includeLabels: [...repoConfig.selectors.includeLabelsAny],
    },
    acceptanceCriteria: criteria,
    dependencies,
    targetRepo: repoConfig.repo,
    workflow: {
      configuredName: repoConfig.workflow ?? null,
      resolvedStepIds: workflow.steps.map((step) => step.id),
    },
    verificationProfile: repoConfig.verificationProfile ?? null,
    runtime: {
      baseBranch: repoConfig.baseBranch,
      branchPrefix: repoConfig.branchPrefix,
      maxConcurrentRuns: repoConfig.maxConcurrentRuns,
    },
    shiftTarget: null,
  }
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- [ ] ') || line.startsWith('- [x] ') || line.startsWith('* [ ] ') || line.startsWith('* [x] '))

  return lines.map((line) => line.replace(/^[-*]\s+\[[ xX]\]\s+/, '').trim()).filter(Boolean)
}
