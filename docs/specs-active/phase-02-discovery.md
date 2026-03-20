# Phase 2: Forge Adapter + Issue Discovery + Leasing

## Objective

Implement the `ForgeAdapter` abstraction, GitHub issue polling with label-based filtering, issue leasing in SQLite, and basic run record creation. After this phase, `run-once` can discover eligible issues and claim them without duplication.

## Dependencies

- **Phase 1**: Config loaded and validated, SQLite initialized with all tables, logger available.

## Inputs

- Validated config (repos, labels, selectors, `tokenEnv`)
- SQLite database (runs, leases, issue_links tables)

## Outputs

- `ForgeAdapter` interface and `GitHubForgeAdapter` implementation
- Issue discovery: poll repos, filter by labels, exclude already-leased
- Lease acquisition and release in SQLite
- Run record creation
- `run-once` command wired up (discover → claim → log → release)
- `--dry-run` mode: discover and log eligible issues without claiming or mutating

---

## Interfaces / Types

### ForgeAdapter

```typescript
/** Forge-agnostic interface for issue/PR operations.
 *  GitHub and Forgejo adapters both implement this. */
interface ForgeAdapter {
  /** List open issues matching label selectors for a repo. */
  listEligibleIssues(repo: RepoConfig): Promise<ForgeIssue[]>;

  /** Get a single issue by number. */
  getIssue(repo: string, issueNumber: number): Promise<ForgeIssue>;

  /** Add labels to an issue. Idempotent. */
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;

  /** Remove labels from an issue. No-op if label not present. */
  removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;

  /** Post a comment on an issue. */
  commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void>;

  /** Validate auth — used by `doctor`. */
  validateAuth(): Promise<{ user: string; scopes: string[] }>;
}

interface ForgeIssue {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  url: string;
}
```

### Issue Selector

```typescript
interface IssueSelector {
  includeLabelsAny: string[];   // issue must have at least one
  excludeLabelsAny: string[];   // issue must have none of these
}

/** Determines if an issue is eligible based on selector config. */
function isEligible(issue: ForgeIssue, selector: IssueSelector): boolean;
```

### Lease Manager

```typescript
interface LeaseManager {
  /** Try to acquire a lease. Returns true if acquired, false if already held. */
  acquire(repo: string, issueNumber: number, owner: string, durationSeconds: number): boolean;

  /** Release a lease. Idempotent. */
  release(repo: string, issueNumber: number): void;

  /** Check if a lease is active. */
  isLeased(repo: string, issueNumber: number): boolean;

  /** Clean up expired leases. Returns count of expired leases removed. */
  cleanExpired(): number;
}
```

### Run Manager

```typescript
interface RunRecord {
  id: string;
  repo: string;
  issueNumber: number;
  issueNodeId: string;
  status: 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed';
  planner: string;
  coder: string;
  reviewer: string;
  iterationCount: number;
  currentPhase: string | null;
  phaseData: Record<string, unknown> | null;
  startedAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  prNumber: number | null;
  branchName: string | null;
  branchSlug: string | null;
  worktreePath: string | null;
  estimatedCostUsd: number;
}

interface RunManager {
  create(params: CreateRunParams): RunRecord;
  update(id: string, fields: Partial<RunRecord>): void;
  getByRepoAndIssue(repo: string, issueNumber: number): RunRecord | null;
  getActive(): RunRecord[];
}
```

### Agent Role Resolution

```typescript
type AgentRole = 'planner' | 'coder' | 'reviewer';
type AgentName = 'claude' | 'codex';

interface ResolvedRoles {
  planner: AgentName;
  coder: AgentName;
  reviewer: AgentName;
}

/** Resolve agent roles: issue labels → repo defaults → global defaults.
 *  Throws if conflicting labels (e.g., both plan:claude and plan:codex). */
function resolveRoles(issueLabels: string[], repoDefaults: RepoConfig['defaults']): ResolvedRoles;
```

### Triage Classification

```typescript
type TriageLevel = 'trivial' | 'standard' | 'architectural';

interface TriageResult {
  level: TriageLevel;
  reason: string;
}

/** Classify issue complexity based on labels, body length, and keywords.
 *  v1 uses heuristics only — no LLM call.
 *  - trivial: body < 200 chars, single file mentioned, label "bug" or "typo"
 *  - architectural: label "breaking", "refactor", "architecture", or 5+ files mentioned
 *  - standard: everything else */
function triageIssue(issue: ForgeIssue): TriageResult;
```

---

## Config Schema Additions

No new top-level config fields. This phase uses existing config:

- `repos[].labels` — for label matching
- `repos[].selectors` — for `includeLabelsAny` / `excludeLabelsAny`
- `repos[].defaults` — for agent role resolution
- `repos[].forge` — to select adapter (`github` or `forgejo`)
- `repos[].apiBaseUrl` — forge API base URL
- `github.tokenEnv` — env var name for the token

---

## Files to Create

```
src/
  forge/
    types.ts               — ForgeAdapter, ForgeIssue, and related interfaces
    github.ts              — GitHubForgeAdapter using @octokit/rest
    factory.ts             — createForgeAdapter(repoConfig, globalConfig) → ForgeAdapter
  discovery/
    selector.ts            — isEligible(), label matching logic
    roles.ts               — resolveRoles() from labels + defaults
    triage.ts              — triageIssue() heuristic classifier
    discover.ts            — orchestrates: list issues → filter → exclude leased → sort
  state/
    leases.ts              — LeaseManager implementation (SQLite)
    runs.ts                — RunManager implementation (SQLite)
    migrations/
      002-indexes.ts       — additional indexes if needed (or fold into 001)
  cli/
    commands/
      run-once.ts          — replace stub: discover → claim → log → release
```

### File Descriptions

- **`forge/types.ts`**: All forge-related interfaces. Shared between GitHub and future Forgejo adapters. Includes `ForgeAdapter`, `ForgeIssue`, PR-related types (stubs for Phase 6).
- **`forge/github.ts`**: `GitHubForgeAdapter` using `@octokit/rest`. Implements `listEligibleIssues` with label filter query params. Paginates. Respects rate limits (log warnings at 20% remaining).
- **`forge/factory.ts`**: Factory that reads `repoConfig.forge` and returns the right adapter. Throws for unknown forge types.
- **`discovery/selector.ts`**: Pure function `isEligible(issue, selector)`. Also `filterEligible(issues, selector)` for batch.
- **`discovery/roles.ts`**: Role resolution with conflict detection. Label prefixes: `plan:`, `code:`, `review:`.
- **`discovery/triage.ts`**: Heuristic triage — no LLM call. Used later by loop engine to adjust iteration limits.
- **`discovery/discover.ts`**: Top-level `discoverEligibleIssues(repoConfig, forgeAdapter, leaseManager)` that chains: list → filter → exclude leased → triage → sort by priority.
- **`state/leases.ts`**: SQLite-backed lease manager. Uses `INSERT OR IGNORE` + check for atomicity. Lease duration from config or default 3600s.
- **`state/runs.ts`**: CRUD for run records. Uses nanoid for IDs. Stores/retrieves `phaseData` as JSON.
- **`cli/commands/run-once.ts`**: Full implementation: load config → create adapters → discover → claim first eligible → create run record → (stub: hand off to loop) → release lease. With `--dry-run`: discover and print, no mutations.

---

## Tests

### Selector Tests (`test/discovery/selector.test.ts`)
- Issue with matching include label is eligible
- Issue missing all include labels is ineligible
- Issue with an exclude label is ineligible
- Issue with both include and exclude labels: exclude wins
- Empty `includeLabelsAny` matches all issues
- Empty `excludeLabelsAny` excludes nothing

### Role Resolution Tests (`test/discovery/roles.test.ts`)
- Labels override repo defaults
- Repo defaults used when no labels present
- Conflicting labels (both `plan:claude` and `plan:codex`) throws
- Partial labels (only `code:codex`) fill others from defaults
- Unknown agent name in label throws

### Triage Tests (`test/discovery/triage.test.ts`)
- Short bug issue → trivial
- Standard feature request → standard
- Issue with "refactor" label → architectural
- Issue mentioning 5+ files → architectural

### Lease Tests (`test/state/leases.test.ts`)
- Acquire succeeds on uncontested issue
- Acquire fails if already leased (not expired)
- Acquire succeeds if previous lease expired
- Release makes issue available
- `cleanExpired` removes only expired leases
- Concurrent acquire attempts: only one wins (test with two calls)

### Run Manager Tests (`test/state/runs.test.ts`)
- Create produces valid record with ID
- Update changes specific fields
- `getByRepoAndIssue` finds correct record
- `getActive` returns only running/queued records

### ForgeAdapter Tests (`test/forge/github.test.ts`)
- Mock Octokit: `listEligibleIssues` returns filtered issues
- Mock Octokit: `addLabels` / `removeLabels` are idempotent
- Rate limit warning logged at threshold
- Auth validation returns user info

### Forge Contract Tests (`test/forge/contract.test.ts`)
- **Shared contract test suite** that any `ForgeAdapter` implementation must pass
- Tests: list issues, get issue, add/remove labels, comment, validate auth
- Parameterized: runs against mock GitHub adapter now, Forgejo adapter in Phase 11
- This is the foundation for `ForgeAdapter` compliance testing

### Integration Test (`test/discovery/discover.test.ts`)
- End-to-end: mock forge → discover → filter → lease → run record created
- Already-leased issues are skipped
- `--dry-run` mode produces output but no DB mutations

---

## Acceptance Criteria

1. `run-once` polls a configured repo's issues via GitHub API (or mock)
2. Only issues matching `includeLabelsAny` and not matching `excludeLabelsAny` are returned
3. Already-leased issues are excluded from selection
4. Agent roles resolve correctly from labels → defaults with conflict detection
5. Lease is acquired before processing and released after
6. Run record is created in SQLite with correct initial state
7. `--dry-run` shows eligible issues without claiming or mutating GitHub
8. Forge contract test suite passes for `GitHubForgeAdapter`
9. Triage classifies issues by heuristic (trivial/standard/architectural)
10. All tests pass: `pnpm test`
