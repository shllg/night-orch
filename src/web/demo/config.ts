/**
 * Synthetic night-orch config for `night-orch demo`. Written to a temp
 * dir at startup so the normal config loader can validate it. None of
 * the tokens / paths in here are real — the demo command never creates
 * forge adapters, spawns workers, or persists anything outside the
 * temporary working directory.
 */
export function buildDemoConfigYaml(options: {
  dbPath: string
  worktreeRoot: string
  logsRoot: string
}): string {
  return `version: 1

github:
  tokenEnv: NIGHT_ORCH_DEMO_TOKEN
  apiBaseUrl: https://api.github.com
  pollIntervalSeconds: 3600

storage:
  dbPath: ${options.dbPath}
  worktreeRoot: ${options.worktreeRoot}
  logsRoot: ${options.logsRoot}
  autoCleanup:
    enabled: false
    intervalMinutes: 60

notifications:
  channels:
    - type: console
  events:
    onRunStarted: false
    onBlocked: false
    onPrReady: false
    onPrUpdated: false
    onError: false
    onRetryExhausted: false

loop:
  maxReviewIterations: 4
  maxTotalAgentPasses: 10
  stopOnPlannerFailure: true
  requireVerificationPass: true
  reviewApprovalKeyword: APPROVED
  reviewNeedsChangesKeyword: CHANGES_REQUIRED
  blockOnAmbiguousReview: true
  maxAutoRetries: 3

security:
  allowGitWrites: false

cost:
  model: subscription
  dailyBudgetUsd: 50
  perRunBudgetUsd: 10
  alerts:
    slackWebhookUrl: null

metrics:
  enabled: false
  host: 127.0.0.1
  port: 9464

mcp:
  enabled: false
  httpHost: 127.0.0.1
  httpPort: 4455

web:
  allowedHosts: [localhost, 127.0.0.1]

workerProfiles:
  claude-default:
    type: claude
    command: claude
    args: []
    workerTimeoutSeconds: 1200
    env: {}
  codex-default:
    type: codex
    command: codex
    args: []
    workerTimeoutSeconds: 1200
    env: {}

repos:
  - repo: acme/web-app
    forge: github
    tokenEnv: NIGHT_ORCH_DEMO_TOKEN
    maxConcurrentRuns: 2
    localPath: /tmp/night-orch-demo/acme-web-app
    baseBranch: main
    branchPrefix: orch/
    labels:
      ready: [ready-for-orch]
      running: orch/working
      blocked: orch/blocked
      needsHuman: orch/needs-human
      reviewReady: orch/review-ready
      error: orch/error
      retry: orch/retry
      planning: orch/planning
      mergeQueued: orch/merge-queued
      merging: orch/merging
      mergeFailed: orch/merge-failed
    defaults:
      planner: claude
      coder: claude
      reviewer: claude
      doneMode: pr-ready
      notifyPriority: normal
      prMentions: []
    verify:
      - pnpm test
    planning:
      prdDirectory: docs/prd
    selectors:
      includeLabelsAny: [ready-for-orch]
      excludeLabelsAny: []
    agents:
      planner: claude-default
      coder: claude-default
      reviewer: claude-default
    mergeQueue:
      enabled: false
      batchSize: 1
      mergeMethod: squash
      retryFlakyOnce: true
      requireApproval: false
      stagingBranchPrefix: orch/staging/

  - repo: acme/api-service
    forge: github
    tokenEnv: NIGHT_ORCH_DEMO_TOKEN
    maxConcurrentRuns: 1
    localPath: /tmp/night-orch-demo/acme-api-service
    baseBranch: main
    branchPrefix: orch/
    labels:
      ready: [ready-for-orch]
      running: orch/working
      blocked: orch/blocked
      needsHuman: orch/needs-human
      reviewReady: orch/review-ready
      error: orch/error
      retry: orch/retry
      planning: orch/planning
      mergeQueued: orch/merge-queued
      merging: orch/merging
      mergeFailed: orch/merge-failed
    defaults:
      planner: codex
      coder: codex
      reviewer: claude
      doneMode: pr-ready
      notifyPriority: high
      prMentions: ['@platform-team']
    verify:
      - pnpm test
      - pnpm typecheck
    planning:
      prdDirectory: docs/prd
    selectors:
      includeLabelsAny: [ready-for-orch]
      excludeLabelsAny: [wontfix]
    agents:
      planner: codex-default
      coder: codex-default
      reviewer: claude-default
    mergeQueue:
      enabled: true
      batchSize: 3
      mergeMethod: merge
      retryFlakyOnce: true
      requireApproval: true
      stagingBranchPrefix: orch/staging/
`
}
