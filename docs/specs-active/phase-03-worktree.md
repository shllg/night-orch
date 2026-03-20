# Phase 3: Git Worktree + Branch + Environment Management

## Objective

Implement deterministic branch naming, git worktree creation/reuse, environment setup (shared vs dedicated Docker Compose stacks), and cleanup helpers. After this phase, each claimed issue gets an isolated working directory with a properly configured environment.

## Dependencies

- **Phase 2**: Issue discovered and claimed, run record created with issue metadata, `ForgeAdapter` available.
- **Phase 1**: Config loaded (storage paths, repo configs), SQLite initialized.

## Inputs

- Run record (repo, issue number, issue title)
- Repo config (localPath, baseBranch, branchPrefix, environment settings)
- Storage config (worktreeRoot)

## Outputs

- Deterministic branch naming with slug pinning in DB
- Worktree creation, reuse, and cleanup
- Per-project environment setup (shared healthcheck or dedicated Docker Compose)
- Bootstrap command execution
- Updated run record with `branchName`, `branchSlug`, `worktreePath`

---

## Interfaces / Types

### Branch Naming

```typescript
/** Generate a URL-safe slug from an issue title.
 *  - lowercase, alphanumeric + hyphens only
 *  - max 50 chars
 *  - trailing hyphens stripped */
function slugify(title: string): string;

/** Build the full branch name: <prefix>/<issueNumber>-<slug> */
function buildBranchName(prefix: string, issueNumber: number, slug: string): string;

/** Get or create a pinned slug for an issue.
 *  First call: derives from title, stores in issue_links.branch_slug.
 *  Subsequent calls: returns stored slug (title changes don't affect it). */
function getOrPinSlug(
  db: Database,
  repo: string,
  issueNumber: number,
  issueTitle: string
): string;
```

### Worktree Manager

```typescript
interface WorktreeInfo {
  path: string;
  branchName: string;
  exists: boolean;
  isClean: boolean;
}

interface WorktreeManager {
  /** Ensure worktree exists for the given run. Creates branch + worktree if needed.
   *  Reuses existing branch/worktree if already present.
   *  Always fetches and updates base branch before creation. */
  ensure(params: EnsureWorktreeParams): Promise<WorktreeInfo>;

  /** Remove a worktree and optionally delete the branch. */
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>;

  /** List all night-orch managed worktrees. */
  list(): Promise<WorktreeInfo[]>;

  /** Check if a worktree path is valid and the branch exists. */
  validate(worktreePath: string): Promise<WorktreeInfo>;
}

interface EnsureWorktreeParams {
  repoLocalPath: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
}
```

### Worktree Path

```typescript
/** Deterministic worktree path:
 *  <worktreeRoot>/<owner>__<repo>/<issueNumber>/
 *  Example: ~/code/.night-orch/worktrees/myorg__myrepo/123/ */
function buildWorktreePath(
  worktreeRoot: string,
  repo: string,       // "owner/name"
  issueNumber: number
): string;
```

### Environment Manager

```typescript
type EnvironmentMode = 'shared' | 'dedicated';

interface EnvironmentManager {
  /** Set up the environment for a worktree based on repo config.
   *  - shared: verify shared services are running via healthcheck
   *  - dedicated: spin up Docker Compose stack with isolated ports */
  setup(params: EnvSetupParams): Promise<EnvSetupResult>;

  /** Tear down dedicated environment. No-op for shared mode. */
  teardown(params: EnvTeardownParams): Promise<void>;

  /** Run bootstrap commands (e.g., pnpm install). */
  bootstrap(worktreePath: string, commands: BootstrapCommand[]): Promise<void>;
}

interface EnvSetupParams {
  worktreePath: string;
  issueNumber: number;
  repoConfig: RepoConfig;
  mode: EnvironmentMode;
}

interface EnvSetupResult {
  mode: EnvironmentMode;
  allocatedPort: number | null;
  composeProjectName: string | null;
  envOverrides: Record<string, string>;
}

interface BootstrapCommand {
  command: string;
  when: 'always' | 'dedicated' | 'shared';
}

interface EnvTeardownParams {
  worktreePath: string;
  issueNumber: number;
  repoConfig: RepoConfig;
  mode: EnvironmentMode;
  composeProjectName: string | null;
}
```

### Port Allocator

```typescript
/** Allocate a port from the configured range.
 *  Inspired by Vendis bin/worktree pattern.
 *  - Reads range from config (e.g., 5101-5199)
 *  - Checks active worktrees for already-allocated ports
 *  - Returns first available port
 *  - Throws if range exhausted */
function allocatePort(
  range: { min: number; max: number },
  usedPorts: number[]
): number;
```

---

## Config Schema Additions

Already defined in Phase 1 config under `repos[].environment`:

```yaml
environment:
  defaultMode: shared | dedicated
  dedicated:
    compose:
      file: docker-compose.dev.yml
      services: [db, redis]
      projectName: "orch-{issue}"
    env:
      copyFrom: .env
      overrides:
        PORT: "{auto:5101-5199}"
      overrideFiles: []
    healthcheck: "curl -f http://localhost:{port}/health"
    teardownOnComplete: true
  shared:
    requireRunning: true
    healthcheck: "curl -f http://localhost:3000/health"
  bootstrap:
    - command: pnpm install --frozen-lockfile
      when: always
  cleanup:
    - command: docker compose -p "orch-{issue}" down -v
      when: dedicated
```

---

## Files to Create

```
src/
  git/
    slug.ts                — slugify(), getOrPinSlug()
    branch.ts              — buildBranchName(), branch create/checkout/exists helpers
    worktree.ts            — WorktreeManager implementation via execa + git CLI
    repo.ts                — fetch, baseBranch validation, repo health checks
  environment/
    manager.ts             — EnvironmentManager implementation
    shared.ts              — shared mode: healthcheck runner
    dedicated.ts           — dedicated mode: Docker Compose up/down, env file generation
    port.ts                — allocatePort() from range
    env-file.ts            — .env copy + overlay (inspired by Vendis pattern)
    bootstrap.ts           — run bootstrap commands in worktree
```

### File Descriptions

- **`git/slug.ts`**: Pure slug generation + DB pinning. Slug is derived once from issue title, stored in `issue_links.branch_slug`, and never re-derived. This prevents branch name changes when issue titles are edited.
- **`git/branch.ts`**: Git branch operations via `execa`: create, checkout, exists-check (local + remote), delete. All operations use the repo local path as cwd.
- **`git/worktree.ts`**: `WorktreeManager` using `git worktree add/remove/list`. Ensures base branch is fetched before creating worktree. If worktree already exists at the path, validates it points to the correct branch. If branch exists remotely but no worktree, creates worktree from existing branch.
- **`git/repo.ts`**: `git fetch origin`, base branch validation (`git rev-parse --verify`), repo health checks (is it a git repo, is remote configured).
- **`environment/manager.ts`**: Top-level environment orchestration. Reads `repos[].environment.defaultMode`, dispatches to shared or dedicated handler.
- **`environment/shared.ts`**: Runs the configured healthcheck command. If `requireRunning: true` and healthcheck fails, throws with clear error message.
- **`environment/dedicated.ts`**: Runs `docker compose -p <projectName> -f <file> up -d <services>`. Substitutes `{issue}` in project name. Waits for healthcheck. On teardown, runs `docker compose ... down -v`.
- **`environment/port.ts`**: Scans existing worktree metadata for allocated ports, returns first free port in range. Stores allocated port in a `.night-orch-env` sidecar file in the worktree root.
- **`environment/env-file.ts`**: Copies base `.env` from repo, appends night-orch override section (delimited by markers), substitutes `{auto:min-max}` port tokens. Pattern from Vendis `bin/worktree`.
- **`environment/bootstrap.ts`**: Runs bootstrap commands sequentially in the worktree directory. Respects `when` filter (always/dedicated/shared). Captures output for logging. Fails fast on non-zero exit.

---

## Git Operation Details

### Worktree Lifecycle

1. **Fetch**: `git fetch origin` in the base repo
2. **Base branch update**: `git checkout <baseBranch> && git pull --ff-only origin <baseBranch>` (only in base repo, not in worktree)
3. **Branch check**: Does `<branchPrefix>/<issue>-<slug>` exist locally or remotely?
   - **Yes, locally**: Reuse. Check if worktree exists at expected path.
   - **Yes, remotely only**: `git branch <name> origin/<name>` to create local tracking branch.
   - **No**: Create from base: `git branch <name> <baseBranch>`
4. **Worktree check**: Does `<worktreePath>` exist?
   - **Yes and valid**: Reuse. Run `git checkout <branchName>` if on wrong branch.
   - **Yes but corrupt**: Remove and recreate.
   - **No**: `git worktree add <worktreePath> <branchName>`
5. **Update**: `git merge origin/<baseBranch> --no-edit` in worktree to pick up latest base changes. If conflict, abort merge and flag as `orch:needs-human`.

### Worktree Cleanup

- `remove()`: `git worktree remove <path> --force`, then optionally `git branch -D <name>`
- `list()`: Parse `git worktree list --porcelain`, filter by worktreeRoot prefix

---

## Tests

### Slug Tests (`test/git/slug.test.ts`)
- "Fix login timeout" → "fix-login-timeout"
- Special chars stripped: "Add @mentions & 🎉 support!" → "add-mentions-support"
- Long titles truncated to 50 chars at word boundary
- Trailing hyphens stripped
- Empty title → "untitled"
- Slug pinning: second call with different title returns original slug

### Branch Tests (`test/git/branch.test.ts`)
- `buildBranchName("orch", 123, "fix-login")` → `"orch/123-fix-login"`
- Branch create from base succeeds
- Branch reuse detects existing branch
- Remote-only branch gets local tracking branch

### Worktree Tests (`test/git/worktree.test.ts`)
- Create new worktree for new issue
- Reuse existing worktree for same issue
- Corrupt worktree is detected and recreated
- Worktree list filtered to night-orch managed paths
- Remove cleans up worktree and optionally branch

### Environment Tests (`test/environment/`)
- **Shared mode**: healthcheck pass → success, healthcheck fail → error
- **Dedicated mode**: Docker Compose commands called with correct project name and services
- **Port allocation**: returns first free port, throws on exhaustion
- **Env file**: base copied, overrides appended in marked section, `{auto:...}` substituted
- **Bootstrap**: commands run sequentially, fail-fast on error, `when` filter respected

### Integration Test (`test/git/worktree-lifecycle.test.ts`)
- Full lifecycle: create worktree → verify files exist → remove → verify cleaned up
- Uses temporary git repo (no real GitHub needed)

---

## Acceptance Criteria

1. Branch names are deterministic: same issue always gets same branch name
2. Slug is pinned on first run — changing issue title doesn't change branch name
3. Worktree is created at the expected deterministic path
4. Rerunning same issue reuses existing branch and worktree
5. Base branch changes are merged into worktree (or conflict flagged)
6. Shared environment mode validates healthcheck before proceeding
7. Dedicated environment mode starts Docker Compose with isolated project name and ports
8. Bootstrap commands run in worktree directory
9. `.env` overlay follows marked-section pattern (Vendis-inspired)
10. Cleanup removes worktree and optionally branch
11. All tests pass: `pnpm test`
