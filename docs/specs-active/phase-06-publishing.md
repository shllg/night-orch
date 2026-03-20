# Phase 6: PR/MR Publication + Label Management

## Objective

Implement branch push, PR creation/update via `ForgeAdapter`, PR body generation, and GitHub issue label mutations. After this phase, a successful loop run produces an actual PR on GitHub with correct labels and status updates.

## Dependencies

- **Phase 5**: Loop engine returns completed `RunContext` with plan, code result, verify results, and review verdict.
- **Phase 3**: Branch exists in worktree with commits.
- **Phase 2**: `ForgeAdapter` interface defined (extend with PR methods).
- **Phase 1**: Config, SQLite, logger.

## Inputs

- Completed `RunContext` (plan, verify results, review verdict, branch name, worktree path)
- Repo config (branchPrefix, labels, defaults.doneMode, defaults.prMentions)
- `ForgeAdapter` for PR and label operations
- `issue_links` table for PR reuse

## Outputs

- Branch pushed to remote
- PR created or updated with structured body
- Issue labels mutated to reflect current state
- `issue_links` table updated with PR number and URL
- Run record updated with PR info

---

## Interfaces / Types

### ForgeAdapter Extensions (PR Methods)

```typescript
/** Extend ForgeAdapter from Phase 2 with PR operations. */
interface ForgeAdapter {
  // ... existing methods from Phase 2 ...

  /** List open PRs for a repo, optionally filtered by head branch. */
  listPullRequests(repo: string, filters?: { head?: string; state?: 'open' | 'closed' | 'all' }): Promise<ForgePR[]>;

  /** Get a single PR by number. */
  getPullRequest(repo: string, prNumber: number): Promise<ForgePR>;

  /** Create a new PR. Returns the created PR. */
  createPullRequest(repo: string, params: CreatePRParams): Promise<ForgePR>;

  /** Update an existing PR (title, body). */
  updatePullRequest(repo: string, prNumber: number, params: UpdatePRParams): Promise<ForgePR>;

  /** Post a comment on a PR. */
  commentOnPR(repo: string, prNumber: number, body: string): Promise<void>;
}

interface ForgePR {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headBranch: string;
  baseBranch: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface CreatePRParams {
  title: string;
  body: string;
  head: string;     // branch name
  base: string;     // target branch
  draft: boolean;
}

interface UpdatePRParams {
  title?: string;
  body?: string;
}
```

### PR Publisher

```typescript
interface PRPublisher {
  /** Push branch and create/update PR.
   *  1. Push branch to remote
   *  2. Find existing PR for this branch (DB → API fallback)
   *  3. Create new PR or update existing
   *  4. Update issue_links table
   *  5. Return PR info */
  publish(ctx: RunContext): Promise<PublishResult>;
}

interface PublishResult {
  prNumber: number;
  prUrl: string;
  created: boolean;  // true if new, false if updated
}
```

### PR Body Compiler

```typescript
interface PRBodyContext {
  issue: { number: number; title: string; url: string };
  plan: PlannerOutput;
  codeResult: CoderOutput;
  verifyResults: VerifyResult[];
  reviewResult: ReviewerOutput;
  roles: ResolvedRoles;
  iterationCount: number;
  triageLevel: TriageLevel;
}

/** Generate structured PR body with all run metadata.
 *  Uses markdown template with sections:
 *  - Link to issue
 *  - Summary of plan
 *  - Implementation summary
 *  - Verification results (pass/fail per command)
 *  - Agent roles used
 *  - Iteration count
 *  - Triage classification
 *  - Auto-generated notice */
function compilePRBody(context: PRBodyContext): string;

/** Generate PR title: "[night-orch] #<issue> <title>" */
function compilePRTitle(issueNumber: number, issueTitle: string): string;
```

### Label Manager

```typescript
interface LabelMutation {
  add: string[];
  remove: string[];
}

interface LabelManager {
  /** Compute and apply label changes for a state transition.
   *  All mutations are idempotent. */
  transition(
    forge: ForgeAdapter,
    repo: string,
    issueNumber: number,
    from: RunStatus,
    to: RunStatus,
    labelConfig: RepoLabelConfig
  ): Promise<void>;
}

/** Compute label mutations for a transition.
 *  Pure function — no side effects, easy to test. */
function computeLabelMutation(
  from: RunStatus,
  to: RunStatus,
  currentLabels: string[],
  labelConfig: RepoLabelConfig
): LabelMutation;
```

### State Transition Labels

```typescript
/** Label changes per transition:
 *
 *  claim (queued → running):
 *    add: [running], remove: [ready]
 *
 *  block (running → blocked):
 *    add: [blocked], remove: [running]
 *
 *  review_ready (running → review_ready):
 *    add: [reviewReady], remove: [running, retry]
 *
 *  error (running → error):
 *    add: [error], remove: [running]
 *
 *  retry (blocked/error → running):
 *    add: [running], remove: [blocked, error, retry]
 */
```

---

## Config Schema Additions

No new top-level fields. Uses existing config:

```yaml
repos[].labels:
  ready: [orch:ready]
  running: orch:running
  blocked: [orch:blocked, orch:needs-human]
  reviewReady: orch:review-ready
  error: orch:error
  retry: orch:retry

repos[].defaults:
  doneMode: pr-ready    # pr-ready | manual-only | merge (v2)
  prMentions: [claude]
```

---

## Files to Create

```
src/
  forge/
    types.ts               — (extend) add ForgePR, CreatePRParams, UpdatePRParams
    github.ts              — (extend) add PR methods to GitHubForgeAdapter
  publishing/
    publisher.ts           — PRPublisher: push, find/create/update PR
    pr-body.ts             — compilePRBody(), compilePRTitle()
    push.ts                — git push via execa
  labels/
    manager.ts             — LabelManager: applies computed label mutations
    transitions.ts         — computeLabelMutation() pure function
  git/
    commit.ts              — (move from loop/) or import — git add + commit
    push.ts                — git push -u origin <branch>
```

### File Descriptions

- **`forge/types.ts`** (extend): Add `ForgePR`, `CreatePRParams`, `UpdatePRParams` interfaces. Add PR methods to `ForgeAdapter` interface.
- **`forge/github.ts`** (extend): Implement `createPullRequest`, `updatePullRequest`, `listPullRequests`, `getPullRequest`, `commentOnPR` using Octokit.
- **`publishing/publisher.ts`**: Orchestrates the full publish flow:
  1. `git push -u origin <branch>` in worktree
  2. Check `issue_links` for existing PR number
  3. If not found, query forge for open PR with matching head branch
  4. If found: update PR body/title
  5. If not found: create new PR
  6. Update `issue_links` with PR number and URL
  7. Update run record with PR info
- **`publishing/pr-body.ts`**: Markdown template for PR body. Sections: issue link, plan summary, implementation summary, verify results table, agent roles, metadata. PR title: `[night-orch] #<issue> <title>` (truncated to fit GitHub limits).
- **`publishing/push.ts`**: `git push -u origin <branchName>`. Handles force-push-needed scenarios by failing and logging (never force push automatically).
- **`labels/manager.ts`**: `LabelManager` that calls `forge.addLabels` / `forge.removeLabels`. Wraps in try-catch per label (partial failure is acceptable). Logs all mutations.
- **`labels/transitions.ts`**: Pure `computeLabelMutation` function. Maps `(from, to)` state pairs to add/remove lists. Normalizes labels config (string → array).

---

## PR Reuse Logic

1. **DB lookup**: `issue_links` table — has PR number for this repo + issue?
2. **API fallback**: If not in DB, query forge for open PR with head = `branchName`
3. **Found, open**: Update same PR (new body, updated title if issue title changed)
4. **Found, closed not merged**: Create new PR on same branch (fresh start)
5. **Found, merged**: Skip publish, mark as completed (edge case: issue was resolved externally)
6. **Not found**: Create new PR

### Edge Cases

- PR creation fails (permissions, branch behind): mark as `orch:error`, notify user
- Push fails (remote rejected): mark as `orch:error`, notify user
- Branch diverged from remote: attempt `git pull --rebase origin <branch>` once, then fail if still diverged

---

## Issue Comment Templates

Post comments on the GitHub issue at key transitions:

```typescript
const COMMENT_TEMPLATES = {
  running: '🔄 night-orch started processing this issue.',
  reviewReady: '✅ PR ready for review: {prUrl}\n\nSummary: {summary}\nIterations: {iterations}',
  blocked: '⚠️ night-orch is blocked on this issue.\n\nReason: {reason}',
  error: '❌ night-orch encountered an error.\n\nError: {error}',
} as const;
```

Comments are posted via `forge.commentOnIssue`. Comment posting is best-effort (failure logged, does not block state transition).

---

## Tests

### PR Body Tests (`test/publishing/pr-body.test.ts`)
- Body includes issue link
- Body includes plan summary
- Body includes verify results table with pass/fail
- Body includes agent roles and iteration count
- Title follows format and is truncated at 256 chars
- Missing optional fields handled gracefully (null plan, etc.)

### PR Publisher Tests (`test/publishing/publisher.test.ts`)
- New PR: push + create PR + update issue_links
- Existing PR (from DB): push + update PR body
- Existing PR (from API fallback): push + update PR + save to DB
- Closed PR, not merged: push + create new PR
- Merged PR: skip publish, return completed
- Push failure: error result, no PR mutation
- PR creation failure: error result, labels set to error

### Label Transition Tests (`test/labels/transitions.test.ts`)
- `queued → running`: add running, remove ready
- `running → blocked`: add blocked, remove running
- `running → review_ready`: add reviewReady, remove running + retry
- `running → error`: add error, remove running
- `blocked → running` (retry): add running, remove blocked + error + retry
- Idempotent: already has target labels → no-op add
- Label config with string vs array normalized correctly

### Label Manager Tests (`test/labels/manager.test.ts`)
- Calls forge.addLabels and forge.removeLabels correctly
- Partial failure logged but doesn't throw
- Empty add/remove lists → no API calls

### Git Push Tests (`test/publishing/push.test.ts`)
- Successful push
- Push rejected → error with clear message
- Branch up-to-date → no-op (still success)

### Forge Contract Tests (`test/forge/contract.test.ts`)
- (Extend) PR create, update, list, get, comment
- Add to shared contract suite for Forgejo reuse in Phase 11

### Integration Test (`test/publishing/full-publish.test.ts`)
- Mock forge: full flow from completed RunContext → PR created → labels updated → DB updated
- Rerun: same issue → same PR updated (not duplicated)

---

## Acceptance Criteria

1. Successful loop run pushes branch and creates/updates PR
2. PR body contains issue link, plan summary, verify results, agent roles, iteration count
3. Existing PRs are reused (never duplicated for the same issue)
4. Issue labels transition correctly at each state change
5. Label mutations are idempotent (safe to apply multiple times)
6. `issue_links` table tracks PR number and URL
7. PR creation failure transitions to `orch:error` with notification
8. Issue comments posted at key transitions (best-effort)
9. Forge contract test suite extended with PR methods
10. All tests pass: `pnpm test`
