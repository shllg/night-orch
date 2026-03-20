# Phase 10: MCP Server Layer

## Objective

Expose night-orch operational data and commands via an MCP (Model Context Protocol) server using `@modelcontextprotocol/sdk`. This allows remote interaction from Claude Code, Claude Desktop, or any MCP client — enabling the user to query status, trigger retries, and inspect runs from a remote session.

## Dependencies

- **Phase 8**: All commands functional (run, sync, cleanup, retry).
- **Phase 5**: Loop engine, RunContext, run records.
- **Phase 2**: ForgeAdapter, discovery.
- **Phase 1**: Config, SQLite, logger.

## Inputs

- SQLite state (runs, leases, issue_links, events, daily_costs)
- Live poller state (is running, current run)
- Config
- ForgeAdapter (for issue/PR queries)

## Outputs

- MCP server exposable via stdio or SSE transport
- MCP tools for querying and controlling night-orch
- MCP resources for reading run data

---

## Interfaces / Types

### MCP Server

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

interface NightOrchMCPServer {
  /** Create and configure the MCP server with all tools and resources. */
  create(deps: MCPDependencies): Server;

  /** Start the server with stdio transport (default). */
  startStdio(): Promise<void>;

  /** Stop the server. */
  stop(): Promise<void>;
}

interface MCPDependencies {
  db: Database;
  config: NightOrchConfig;
  forgeAdapters: Map<string, ForgeAdapter>;
  poller: Poller | null;  // null if not in `run` mode
  metrics: MetricsService | null;
}
```

### MCP Tools

```typescript
/** Tools exposed via MCP. Each tool has a name, description, input schema, and handler. */

// --- Query Tools ---

interface StatusToolInput {
  /** Optional: filter by repo. */
  repo?: string;
}
// Returns: summary of active/recent runs, eligible issues, poller state

interface RunDetailToolInput {
  runId: string;
}
// Returns: full run record with phase history, plan, verify results

interface ListRunsToolInput {
  repo?: string;
  status?: string;
  limit?: number;
}
// Returns: list of run records matching filters

interface ListIssuesToolInput {
  repo: string;
  /** Show eligible, running, blocked, or all. */
  filter?: 'eligible' | 'running' | 'blocked' | 'all';
}
// Returns: list of issues with their orchestrator state

interface CostReportToolInput {
  /** Number of days to include. Default: 7. */
  days?: number;
}
// Returns: daily cost breakdown, total cost, run counts

// --- Action Tools ---

interface RetryToolInput {
  repo: string;
  issueNumber: number;
  resetPlan?: boolean;
}
// Returns: confirmation message

interface SyncToolInput {
  dryRun?: boolean;
}
// Returns: sync results

interface CleanupToolInput {
  dryRun?: boolean;
}
// Returns: cleanup results
```

### MCP Resources

```typescript
/** Resources exposed via MCP for reading data. */

// night-orch://status
// → current operational status, poller state, active runs

// night-orch://runs/{runId}
// → detailed run record with full phase history

// night-orch://config
// → sanitized config (tokens redacted)

// night-orch://logs/{runId}
// → recent log entries for a specific run

// night-orch://metrics
// → current metric values (if metrics enabled)
```

---

## Config Schema Additions

```yaml
mcp:
  enabled: true
  transport: stdio        # stdio | sse (future)
  # SSE config (future):
  # port: 3100
  # host: 127.0.0.1
```

Add to Zod schema:

```typescript
mcp: z.object({
  enabled: z.boolean().default(false),
  transport: z.enum(['stdio']).default('stdio'),  // 'sse' added later
}).default({ enabled: false, transport: 'stdio' }),
```

---

## Files to Create

```
src/
  mcp/
    server.ts              — MCP server creation and lifecycle
    tools/
      status.ts            — night-orch-status tool
      run-detail.ts        — night-orch-run-detail tool
      list-runs.ts         — night-orch-list-runs tool
      list-issues.ts       — night-orch-list-issues tool
      cost-report.ts       — night-orch-cost-report tool
      retry.ts             — night-orch-retry tool
      sync.ts              — night-orch-sync tool
      cleanup.ts           — night-orch-cleanup tool
    resources/
      status.ts            — night-orch://status resource
      runs.ts              — night-orch://runs/{runId} resource
      config.ts            — night-orch://config resource
      logs.ts              — night-orch://logs/{runId} resource
      metrics.ts           — night-orch://metrics resource
  cli/
    commands/
      mcp.ts               — `night-orch mcp` command to start MCP server
```

### File Descriptions

- **`mcp/server.ts`**: Creates `Server` instance from `@modelcontextprotocol/sdk`. Registers all tools and resources. Handles `stdio` transport. Server name: `night-orch`, version from package.json.
- **`mcp/tools/status.ts`**: Queries DB for active runs, eligible issues (via ForgeAdapter), poller state. Returns formatted summary with counts.
- **`mcp/tools/run-detail.ts`**: Queries single run by ID. Returns full record including phase history from `phaseData`, plan, verify results.
- **`mcp/tools/list-runs.ts`**: Lists runs with optional repo/status filters and limit. Returns formatted table of runs.
- **`mcp/tools/list-issues.ts`**: Queries forge for issues, cross-references with local state. Shows eligible/running/blocked status per issue.
- **`mcp/tools/cost-report.ts`**: Queries `daily_costs` table. Returns daily breakdown and totals. Includes budget utilization percentage.
- **`mcp/tools/retry.ts`**: Calls `RetryEngine.retry()`. Returns confirmation with run ID.
- **`mcp/tools/sync.ts`**: Calls `SyncEngine.reconcile()`. Returns sync results.
- **`mcp/tools/cleanup.ts`**: Calls `CleanupEngine.run()`. Returns cleanup results.
- **`mcp/resources/status.ts`**: Resource handler for `night-orch://status`. Returns JSON with poller state, active runs count, recent completions.
- **`mcp/resources/runs.ts`**: Resource template handler for `night-orch://runs/{runId}`. Returns JSON run record.
- **`mcp/resources/config.ts`**: Returns sanitized config (token env var names shown, not values).
- **`mcp/resources/logs.ts`**: Reads recent events from `events` table for a run. Returns formatted log entries.
- **`mcp/resources/metrics.ts`**: If metrics service available, returns current metric values as JSON.
- **`cli/commands/mcp.ts`**: New CLI command `night-orch mcp`. Starts MCP server with stdio transport. Intended to be configured as an MCP server in Claude Code settings.

---

## MCP Server Registration

The user configures night-orch as an MCP server in their Claude Code settings:

```json
{
  "mcpServers": {
    "night-orch": {
      "command": "night-orch",
      "args": ["mcp", "--config", "~/.config/night-orch/config.yaml"]
    }
  }
}
```

Then from a Claude Code session:

```
> Use the night-orch-status tool to check current run status.
> Use night-orch-retry to re-queue issue #42 in myorg/myrepo.
```

---

## Tool Schemas (JSON Schema for MCP)

```typescript
// Example: status tool
{
  name: 'night-orch-status',
  description: 'Get current night-orch operational status including active runs, eligible issues, and poller state.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Optional: filter status to a specific repo (owner/name format)',
      },
    },
  },
}

// Example: retry tool
{
  name: 'night-orch-retry',
  description: 'Force a re-run of a specific issue. Resets blocked/error state and re-queues for processing.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository in owner/name format' },
      issueNumber: { type: 'number', description: 'Issue number to retry' },
      resetPlan: { type: 'boolean', description: 'Re-run planner instead of reusing existing plan', default: false },
    },
    required: ['repo', 'issueNumber'],
  },
}
```

---

## Tests

### MCP Server Tests (`test/mcp/server.test.ts`)
- Server creates with all tools registered
- Server creates with all resources registered
- Tool list matches expected tool names
- Resource list matches expected resource URIs

### Tool Tests (`test/mcp/tools/`)
- **status**: Returns formatted summary with run counts
- **run-detail**: Returns full run record, 404 for unknown ID
- **list-runs**: Filters by repo and status, respects limit
- **list-issues**: Returns issues with local state overlay
- **cost-report**: Returns daily breakdown for requested period
- **retry**: Calls RetryEngine, returns confirmation
- **sync**: Calls SyncEngine, returns results
- **cleanup**: Calls CleanupEngine, returns results

### Resource Tests (`test/mcp/resources/`)
- **status**: Returns valid JSON with expected fields
- **runs**: Returns run record for valid ID, error for unknown
- **config**: Token values redacted, env var names shown
- **logs**: Returns recent events for run
- **metrics**: Returns metric values when enabled, error when disabled

### Integration Test (`test/mcp/integration.test.ts`)
- Create server → call status tool → verify response
- Create server → call retry tool → verify run state changed
- Resource reads return correct data from DB

---

## Acceptance Criteria

1. `night-orch mcp` starts MCP server with stdio transport
2. All 8 tools registered and callable from MCP client
3. All 5 resources readable from MCP client
4. Status tool returns meaningful operational summary
5. Retry tool successfully re-queues issues
6. Config resource redacts sensitive values
7. Server handles concurrent tool calls correctly
8. Server shuts down gracefully
9. Tool input validation rejects invalid parameters
10. All tests pass: `pnpm test`
