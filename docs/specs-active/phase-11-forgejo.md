# Phase 11: Forgejo Adapter

## Objective

Implement a `ForgejoForgeAdapter` that fulfills the `ForgeAdapter` contract, allowing night-orch to process issues from self-hosted Forgejo instances alongside GitHub. The adapter reuses the forge contract test suite from Phase 2 to guarantee behavioral parity.

## Dependencies

- **Phase 2**: `ForgeAdapter` interface defined, forge contract test suite exists, factory supports adapter registration.
- **Phase 6**: PR-related `ForgeAdapter` methods defined.
- **Phase 1**: Config supports `forge: forgejo` and per-repo `apiBaseUrl`.

## Inputs

- Repo config with `forge: 'forgejo'` and `apiBaseUrl` pointing to Forgejo instance
- Token from env var (Forgejo personal access token)
- Same issue/PR operations as GitHub but via Forgejo API

## Outputs

- `ForgejoForgeAdapter` implementing full `ForgeAdapter` interface
- Forge contract tests passing for Forgejo adapter
- Factory returns Forgejo adapter when `forge: 'forgejo'`
- `doctor` validates Forgejo auth

---

## Interfaces / Types

The `ForgejoForgeAdapter` implements the same `ForgeAdapter` interface from Phase 2/6. No new interfaces are needed — that's the point of the abstraction.

```typescript
/** Forgejo adapter implementing the same ForgeAdapter contract as GitHub.
 *  Uses Forgejo's REST API which is largely Gitea-compatible.
 *
 *  Key API differences from GitHub:
 *  - Base URL: user-configured (e.g., https://forgejo.example.com/api/v1)
 *  - Auth: token via Authorization header (same pattern)
 *  - Issue labels: same concept, different endpoint format
 *  - PRs: Forgejo calls them "pull requests" with Gitea-compatible endpoints
 *  - Node IDs: not available in Forgejo — use numeric IDs throughout
 *  - Pagination: Link header based (same as GitHub)
 */
class ForgejoForgeAdapter implements ForgeAdapter {
  constructor(config: ForgejoConfig);

  // All ForgeAdapter methods implemented...
}

interface ForgejoConfig {
  /** Base URL for the Forgejo API, e.g., https://forgejo.example.com/api/v1 */
  apiBaseUrl: string;
  /** Token for authentication. */
  token: string;
}
```

### API Mapping

```typescript
/** Forgejo API endpoint mapping (Gitea-compatible):
 *
 *  listEligibleIssues → GET /repos/{owner}/{repo}/issues?state=open&labels=...
 *  getIssue           → GET /repos/{owner}/{repo}/issues/{number}
 *  addLabels          → POST /repos/{owner}/{repo}/issues/{number}/labels
 *  removeLabels       → DELETE /repos/{owner}/{repo}/issues/{number}/labels/{id}
 *  commentOnIssue     → POST /repos/{owner}/{repo}/issues/{number}/comments
 *  validateAuth       → GET /api/v1/user
 *
 *  listPullRequests   → GET /repos/{owner}/{repo}/pulls?state=open
 *  getPullRequest     → GET /repos/{owner}/{repo}/pulls/{number}
 *  createPullRequest  → POST /repos/{owner}/{repo}/pulls
 *  updatePullRequest  → PATCH /repos/{owner}/{repo}/pulls/{number}
 *  commentOnPR        → POST /repos/{owner}/{repo}/issues/{number}/comments
 *                       (Forgejo uses issue comment endpoint for PR comments)
 */
```

---

## Forgejo vs GitHub Differences

| Feature | GitHub | Forgejo |
|---------|--------|---------|
| API base | `api.github.com` | User-configured per instance |
| Auth header | `Authorization: Bearer <token>` | `Authorization: token <token>` |
| Node IDs | Available (GraphQL) | Not available — use numeric IDs |
| Label add | `POST .../labels` with `{labels: ["name"]}` | `POST .../labels` with `{labels: [id]}` (label IDs) |
| Label remove | `DELETE .../labels/{name}` | `DELETE .../labels/{id}` |
| PR comments | Separate endpoint | Uses issue comments endpoint |
| Rate limits | X-RateLimit headers | May not have rate limits |
| Pagination | Link header | Link header (same) |
| Webhook events | Different payload format | Gitea-compatible format |

### Label ID Resolution

Forgejo requires label IDs (not names) for add/remove operations. The adapter must:

1. On first use, fetch all labels for the repo: `GET /repos/{owner}/{repo}/labels`
2. Cache the name→ID mapping for the session
3. Resolve label names from config to IDs before API calls
4. Invalidate cache on 404 (label may have been created/deleted)

```typescript
interface LabelCache {
  /** Get label ID by name. Fetches from API if not cached. */
  getIdByName(repo: string, labelName: string): Promise<number | null>;

  /** Invalidate cache for a repo (force re-fetch). */
  invalidate(repo: string): void;
}
```

---

## Config Schema Additions

No new top-level fields. Per-repo config already supports:

```yaml
repos:
  - repo: myuser/myproject
    forge: forgejo
    apiBaseUrl: https://forgejo.example.com/api/v1
    tokenEnv: FORGEJO_TOKEN    # per-repo token override
    localPath: ~/code/myproject
    baseBranch: main
    # ... rest of repo config identical to GitHub repos
```

Add `tokenEnv` as optional per-repo override (falls back to global `github.tokenEnv`):

```typescript
// In repo config schema:
tokenEnv: z.string().optional(),  // per-repo token env var override
```

---

## Files to Create

```
src/
  forge/
    forgejo.ts             — ForgejoForgeAdapter implementation
    forgejo-labels.ts      — Label name→ID cache/resolver
    types.ts               — (update) ensure ForgeIssue.nodeId is optional
  config/
    schema.ts              — (update) add per-repo tokenEnv
```

### File Descriptions

- **`forge/forgejo.ts`**: Full `ForgeAdapter` implementation using `fetch` (Node.js built-in). Handles Forgejo-specific auth format, label ID resolution, and API endpoint mapping. Pagination via Link header parsing. Error handling with clear messages for auth failures and missing repos.
- **`forge/forgejo-labels.ts`**: `LabelCache` that fetches all labels for a repo, builds name→ID map, and caches for the session. Used by `addLabels` and `removeLabels` to translate config label names to Forgejo label IDs.
- **`forge/types.ts`** (update): Make `ForgeIssue.nodeId` optional (`string | null`) since Forgejo doesn't provide GraphQL node IDs. All code using `nodeId` must handle null.
- **`config/schema.ts`** (update): Add optional `tokenEnv` to repo config. Factory uses per-repo token if set, otherwise falls back to global token.

---

## HTTP Client

Use Node.js built-in `fetch` (Node 22+) instead of adding a Forgejo-specific SDK:

```typescript
/** Thin HTTP wrapper for Forgejo API calls.
 *  - Sets auth header with token
 *  - Handles pagination via Link header
 *  - Parses JSON responses
 *  - Throws typed errors for 4xx/5xx */
class ForgejoClient {
  constructor(baseUrl: string, token: string);

  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;

  /** Paginated GET — follows Link headers until all pages fetched. */
  getPaginated<T>(path: string, params?: Record<string, string>): Promise<T[]>;
}
```

---

## Contract Test Reuse

The key design goal: **the same contract test suite validates both adapters**.

```typescript
// test/forge/contract.test.ts (from Phase 2)
// Parameterized test suite:

function forgeContractTests(
  name: string,
  createAdapter: () => Promise<{ adapter: ForgeAdapter; cleanup: () => Promise<void> }>
) {
  describe(`ForgeAdapter contract: ${name}`, () => {
    // ... all contract tests ...
  });
}

// Phase 2: registered GitHub
forgeContractTests('GitHub', () => createMockGitHubAdapter());

// Phase 11: register Forgejo
forgeContractTests('Forgejo', () => createMockForgejoAdapter());
```

The mock Forgejo adapter uses a mock HTTP server that simulates Forgejo API responses. This ensures the adapter correctly translates between `ForgeAdapter` semantics and Forgejo API format.

---

## Tests

### Forgejo Adapter Tests (`test/forge/forgejo.test.ts`)
- Auth validation: correct header format (`token <value>`)
- Issue listing: translates Forgejo response to `ForgeIssue` format
- Label add: resolves name→ID, posts correct body
- Label remove: resolves name→ID, deletes correct endpoint
- PR create: maps `CreatePRParams` to Forgejo `POST /pulls` body
- PR update: maps `UpdatePRParams` to Forgejo `PATCH /pulls` body
- PR comment: uses issue comment endpoint
- Pagination: follows Link headers correctly
- 401 error: clear auth failure message
- 404 error: clear "repo not found" message

### Label Cache Tests (`test/forge/forgejo-labels.test.ts`)
- First call fetches labels from API
- Subsequent calls use cache
- Unknown label name returns null
- Cache invalidation triggers re-fetch
- Concurrent access safe (no duplicate fetches)

### Contract Tests (`test/forge/contract.test.ts`)
- (Extend) Forgejo adapter passes all existing contract tests
- Both GitHub and Forgejo adapters produce identical `ForgeIssue` structure
- Both handle empty issue lists
- Both handle label operations idempotently
- Both handle PR lifecycle (create, update, list, get, comment)

### ForgejoClient Tests (`test/forge/forgejo-client.test.ts`)
- GET with params
- POST with JSON body
- PATCH with JSON body
- DELETE
- Paginated GET follows Link headers
- Auth header set correctly
- 4xx → typed error with message
- 5xx → typed error with message
- Timeout handling

### Integration Test (`test/forge/forgejo-integration.test.ts`)
- Mock Forgejo server → full discovery → claim → create PR flow
- Label mutations work with ID resolution
- Existing PR detection and reuse

---

## Acceptance Criteria

1. `ForgejoForgeAdapter` implements full `ForgeAdapter` interface
2. Forge contract test suite passes for both GitHub and Forgejo adapters
3. `forge: forgejo` in repo config routes to Forgejo adapter via factory
4. Per-repo `tokenEnv` allows different tokens per forge instance
5. Label name→ID resolution works transparently
6. `doctor` validates Forgejo auth (`GET /api/v1/user`)
7. PR operations work through Forgejo API (create, update, comment)
8. `ForgeIssue.nodeId` handled as optional throughout codebase
9. No Forgejo-specific SDK dependency — uses built-in `fetch`
10. All tests pass: `pnpm test`
