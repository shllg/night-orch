---
name: forge-adapter
description: ForgeAdapter interface, contract tests, adding methods, rate limit handling
---

# Forge Adapter Skill

ForgeAdapter abstracts GitHub and Forgejo behind a common interface. All forge operations go through this — never call Octokit or Forgejo API directly.

## Interface Pattern

```typescript
// src/forge/adapter.ts
export interface ForgeAdapter {
  getIssue(owner: string, repo: string, number: number): Promise<Issue>;
  listIssues(owner: string, repo: string, opts: ListOpts): Promise<Issue[]>;
  createComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  setLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
  createPullRequest(owner: string, repo: string, pr: PullRequestInput): Promise<PullRequest>;
  // ... etc
}
```

## Adding a New Method

1. **Add to interface** in `src/forge/adapter.ts`
2. **Implement in GitHub** adapter: `src/forge/github.ts`
3. **Implement in Forgejo** adapter: `src/forge/forgejo.ts`
4. **Add contract test** in `test/forge/contract.test.ts`
5. **Both adapters must pass** the same contract test suite

## Contract Test Pattern

```typescript
// test/forge/contract.test.ts
import { describe, it, expect } from 'vitest';

function forgeContractTests(name: string, createAdapter: () => ForgeAdapter) {
  describe(`${name} ForgeAdapter contract`, () => {
    it('getIssue returns issue with required fields', async () => {
      const adapter = createAdapter();
      const issue = await adapter.getIssue('owner', 'repo', 1);
      expect(issue).toHaveProperty('number');
      expect(issue).toHaveProperty('title');
      expect(issue).toHaveProperty('body');
      expect(issue).toHaveProperty('labels');
    });
    // ... more contract tests
  });
}

// Run for both adapters
forgeContractTests('GitHub', () => new GitHubAdapter(mockOctokit));
forgeContractTests('Forgejo', () => new ForgejoAdapter(mockClient));
```

## Rate Limit Handling

- Check `x-ratelimit-remaining` header on responses
- When remaining < 10, add delay between requests
- On 429 (rate limited), wait for `x-ratelimit-reset` timestamp
- Log rate limit events at `warn` level
- NEVER retry indefinitely — max 3 retries with exponential backoff

## Security Rules

- Tokens are created in the adapter constructor and stored as private fields
- NEVER expose tokens in method signatures, logs, or error messages
- Log API call summaries (method, URL, status code) at `debug` level — never full bodies
- Error messages must not include auth headers

## When Working on Forge Code

1. Check the phase spec: `docs/specs-active/phase-11-forgejo.md` (Forgejo) or relevant phase
2. Always modify interface first, then both implementations
3. Run contract tests: `pnpm test -- --run test/forge/contract.test.ts`
4. Consider rate limits for any new API call
5. Never access tokens outside the adapter
