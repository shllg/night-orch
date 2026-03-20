# Phase 7: Notifications + PR Mentions

## Objective

Implement a pluggable notification system (console, webhook, GitHub comment, SMTP) and configurable PR mention comments for triggering GitHub-side AI integrations. After this phase, users are notified of run outcomes and optional PR mentions are posted.

## Dependencies

- **Phase 6**: PR published, labels managed, `ForgeAdapter` has comment methods.
- **Phase 2**: `ForgeAdapter.commentOnPR()` available.
- **Phase 1**: Config (notifications, appMentions), logger.

## Inputs

- Notification config (channels, events)
- App mention config (templates, per-repo/per-issue settings)
- Run outcome: `RunContext` with terminal state (review_ready, blocked, error)
- PR info (number, URL) when available

## Outputs

- Notification dispatched through all configured channels
- PR mention comments posted (once per publish cycle)
- `notify-test` command functional

---

## Interfaces / Types

### Notification System

```typescript
type NotificationEvent =
  | 'run_started'
  | 'blocked'
  | 'pr_ready'
  | 'pr_updated'
  | 'error'
  | 'retry_exhausted';

interface NotificationPayload {
  event: NotificationEvent;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  state: string;
  prUrl: string | null;
  prNumber: number | null;
  summary: string;
  blockingReason: string | null;
  reviewSummary: string | null;
  iterationCount: number;
  timestamp: string;
}

interface NotificationChannel {
  readonly type: string;

  /** Send a notification. Must not throw — log and return false on failure. */
  send(payload: NotificationPayload): Promise<boolean>;

  /** Validate channel config. Used by `doctor`. */
  validate(): Promise<{ valid: boolean; error: string | null }>;
}
```

### Channel Implementations

```typescript
// Console channel — always available, logs to stdout via pino
interface ConsoleChannelConfig {
  type: 'console';
}

// Webhook channel — POST JSON to URL
interface WebhookChannelConfig {
  type: 'webhook';
  urlEnv: string;            // env var name containing the URL
  headers?: Record<string, string>;  // optional extra headers
  timeoutMs?: number;        // default 10000
}

// GitHub comment channel — post notification as issue comment
interface GitHubCommentChannelConfig {
  type: 'github-comment';
  // Uses existing ForgeAdapter — no extra config needed
}

// SMTP channel — send email
interface SMTPChannelConfig {
  type: 'smtp';
  hostEnv: string;           // env var for SMTP host
  port: number;
  secure: boolean;
  fromEnv: string;           // env var for from address
  toEnv: string;             // env var for recipient(s)
  authUserEnv?: string;
  authPassEnv?: string;
}
```

### Notification Dispatcher

```typescript
interface NotificationDispatcher {
  /** Send notification to all configured channels that have the event enabled.
   *  Best-effort: individual channel failures logged but don't block others. */
  dispatch(payload: NotificationPayload): Promise<NotificationReport>;

  /** Send a test notification through all channels. */
  sendTest(): Promise<NotificationReport>;
}

interface NotificationReport {
  sent: { channel: string; success: boolean; error: string | null }[];
  totalSent: number;
  totalFailed: number;
}
```

### PR Mentions

```typescript
interface AppMentionConfig {
  enabled: boolean;
  commentTemplate: string;
}

interface PRMentionManager {
  /** Post configured PR mention comments after publish.
   *  Only posts each mention once per publish cycle.
   *  Respects per-issue label overrides (pr-mention:claude, etc.).
   *  Skips if mention was already posted for current commit. */
  postMentions(ctx: RunContext, prNumber: number): Promise<void>;
}

/** Determine which mentions to post based on:
 *  1. Issue labels (pr-mention:claude, pr-mention:codex)
 *  2. Repo defaults (defaults.prMentions)
 *  3. Global appMentions config (enabled flag) */
function resolveMentions(
  issueLabels: string[],
  repoDefaults: RepoConfig['defaults'],
  appMentions: Record<string, AppMentionConfig>
): string[];   // list of mention keys to post (e.g., ['claude'])
```

### Mention Deduplication

```typescript
/** Track which mentions have been posted for which PR + commit.
 *  Prevents duplicate mention comments on PR update. */
interface MentionTracker {
  /** Check if mention was already posted for this PR at this commit. */
  wasPosted(repo: string, prNumber: number, mentionKey: string, commitSha: string): boolean;

  /** Record that mention was posted. */
  recordPosted(repo: string, prNumber: number, mentionKey: string, commitSha: string): void;
}
```

---

## Config Schema Additions

No new top-level fields. Uses existing config:

```yaml
notifications:
  channels:
    - type: console
    - type: webhook
      urlEnv: NIGHT_ORCH_WEBHOOK_URL
    - type: github-comment
    - type: smtp
      hostEnv: SMTP_HOST
      port: 587
      secure: true
      fromEnv: SMTP_FROM
      toEnv: SMTP_TO
      authUserEnv: SMTP_USER
      authPassEnv: SMTP_PASS
  events:
    onRunStarted: false
    onBlocked: true
    onPrReady: true
    onError: true
    onRetryExhausted: true

github:
  appMentions:
    claude:
      enabled: true
      commentTemplate: "@claude Please review this PR and apply fixes if needed."
    codex:
      enabled: false
      commentTemplate: "@codex please review and patch any remaining issues."
```

---

## DB Schema Addition

```sql
CREATE TABLE IF NOT EXISTS mention_tracking (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  mention_key TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  posted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (repo, pr_number, mention_key, commit_sha)
);
```

Add as migration `003-mention-tracking.ts`.

---

## Files to Create

```
src/
  notify/
    types.ts               — NotificationEvent, NotificationPayload, NotificationChannel
    dispatcher.ts          — NotificationDispatcher: routes to all channels
    channels/
      console.ts           — ConsoleChannel: pino structured log
      webhook.ts           — WebhookChannel: HTTP POST with fetch
      github-comment.ts    — GitHubCommentChannel: uses ForgeAdapter
      smtp.ts              — SMTPChannel: nodemailer
    factory.ts             — createChannels(config) → NotificationChannel[]
    payload.ts             — buildPayload(ctx, event) → NotificationPayload
  mentions/
    manager.ts             — PRMentionManager
    resolver.ts            — resolveMentions() from labels + defaults + config
    tracker.ts             — MentionTracker (SQLite-backed)
  state/
    migrations/
      003-mention-tracking.ts
  cli/
    commands/
      notify-test.ts       — (replace stub) send test notification through all channels
```

### File Descriptions

- **`notify/types.ts`**: All notification interfaces and types.
- **`notify/dispatcher.ts`**: Iterates configured channels, filters by event enablement, dispatches in parallel, collects results. Never throws — all failures captured in report.
- **`notify/channels/console.ts`**: Logs notification payload via pino at `info` level. Always succeeds.
- **`notify/channels/webhook.ts`**: `POST` JSON payload to URL from env var. Timeout configurable (default 10s). Retries once on 5xx. Logs response status.
- **`notify/channels/github-comment.ts`**: Uses `ForgeAdapter.commentOnIssue()` to post a formatted notification comment. Only posts if issue number is available.
- **`notify/channels/smtp.ts`**: Uses `nodemailer` to send email. Subject: `[night-orch] {event}: {repo}#{issue}`. Body: plain text from payload. Optional: skip if nodemailer not installed (graceful degradation).
- **`notify/factory.ts`**: Creates channel instances from config array. Unknown types logged and skipped.
- **`notify/payload.ts`**: `buildPayload(ctx, event)` constructs `NotificationPayload` from `RunContext` and event type.
- **`mentions/manager.ts`**: After PR publish, resolves which mentions to post, checks tracker for dedup, posts comments via `ForgeAdapter.commentOnPR()`, records in tracker.
- **`mentions/resolver.ts`**: Pure function. Checks issue labels for `pr-mention:*`, falls back to repo defaults, checks global `appMentions[key].enabled`.
- **`mentions/tracker.ts`**: SQLite-backed. Uses `mention_tracking` table. `wasPosted` and `recordPosted` are simple queries.
- **`cli/commands/notify-test.ts`**: Creates a test payload and dispatches through all configured channels. Reports which succeeded/failed.

---

## Webhook Payload Format

```json
{
  "event": "pr_ready",
  "repo": "myorg/myrepo",
  "issueNumber": 123,
  "issueTitle": "Fix login timeout",
  "state": "review_ready",
  "prUrl": "https://github.com/myorg/myrepo/pull/456",
  "prNumber": 456,
  "summary": "Implemented login timeout fix with retry logic",
  "blockingReason": null,
  "reviewSummary": "APPROVED: All checks pass, implementation matches plan",
  "iterationCount": 2,
  "timestamp": "2026-03-20T04:30:00Z"
}
```

---

## Tests

### Dispatcher Tests (`test/notify/dispatcher.test.ts`)
- Dispatches to all enabled channels
- Skipped event (onRunStarted: false) → channel not called
- One channel fails → others still called, failure in report
- All channels fail → report shows all failures, no throw

### Console Channel Tests (`test/notify/channels/console.test.ts`)
- Logs payload at info level
- Always returns success

### Webhook Channel Tests (`test/notify/channels/webhook.test.ts`)
- Sends POST with correct JSON body and headers
- Timeout after configured ms
- 5xx → one retry, then failure
- 4xx → immediate failure (no retry)
- Missing env var → validate returns invalid

### GitHub Comment Channel Tests (`test/notify/channels/github-comment.test.ts`)
- Posts formatted comment via ForgeAdapter
- Missing issue number → skipped (not error)

### SMTP Channel Tests (`test/notify/channels/smtp.test.ts`)
- Sends email with correct subject and body
- Auth credentials from env vars
- Missing env vars → validate returns invalid

### Mention Resolution Tests (`test/mentions/resolver.test.ts`)
- Issue label `pr-mention:claude` → include claude
- No labels → use repo defaults
- `appMentions.codex.enabled: false` → exclude codex even if in defaults
- Both label and default → no duplicates

### Mention Tracker Tests (`test/mentions/tracker.test.ts`)
- First post for PR+commit+key → not posted
- After record → was posted returns true
- Different commit sha → not posted (allows re-mention on new push)

### Mention Manager Tests (`test/mentions/manager.test.ts`)
- Resolves mentions, posts comment, records in tracker
- Already posted → skipped
- Comment posting failure → logged, not thrown

### notify-test Command Test (`test/cli/notify-test.test.ts`)
- Test payload dispatched through all channels
- Report printed to stdout

---

## Acceptance Criteria

1. Notifications dispatched through all configured channels on enabled events
2. Webhook sends correct JSON payload with configurable timeout
3. GitHub comment posts formatted notification on issue
4. SMTP sends email with correct subject and body
5. Individual channel failures don't block other channels
6. PR mention comments posted after publish (once per cycle per mention key)
7. Mention deduplication prevents duplicate comments on same commit
8. `notify-test` command sends test notification through all channels
9. `doctor` validates notification channel configs
10. All tests pass: `pnpm test`
