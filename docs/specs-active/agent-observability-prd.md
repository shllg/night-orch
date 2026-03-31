# PRD: Agent Session Observability

## Problem

When night-orch dispatches a worker (Claude/Codex/ACP), the operator has **zero visibility** into what the agent is doing until it finishes. A Codex coder can run for 30 minutes with no indication of whether it's productively implementing features, stuck in a loop, or doing the wrong thing entirely.

Current state:
- `night-orch status` / `watch` shows "running" with phase name and elapsed time — nothing more
- Agent stdout is fully buffered by `execWithTimeout()` — only available after completion
- The TUI polls the DB every 2 seconds but the DB has no in-flight data
- MCP tools show historical run data only

This was identified as a critical gap during the first real-world run on 2026-03-31.

## Goals

1. **Live agent output streaming** — see what the agent is writing/thinking as it works
2. **Tool call visibility** — know which tools the agent is invoking (reading files, running commands, editing code)
3. **Progress indication** — understand how far along the agent is (token count, turn count, files touched)
4. **Retrospective session logs** — after a run, review the full agent session for debugging
5. **Multi-channel delivery** — stream to TUI, MCP, and persistent logs simultaneously

## Non-Goals

- Token-level streaming (character by character) — event-level granularity is sufficient
- Modifying agent behavior mid-run (that's the reaction engine's job)
- Sub-agent tracing within Codex (not exposed by Codex CLI)

## Architecture

### Event Pipeline

```
Agent Process (Claude/Codex/ACP)
        │
        ├── stdout (streaming events)
        │
    ┌───▼───────────────┐
    │  StreamingExec     │  replaces execWithTimeout for workers
    │  (event emitter)   │  parses events as they arrive
    └───┬───────────────┘
        │
        ├── AgentEvent objects
        │
    ┌───▼───────────────┐
    │  EventBus          │  in-process pub/sub
    │  (per-run)         │
    └───┬───┬───┬───────┘
        │   │   │
        ▼   ▼   ▼
      TUI  MCP  DB (event_log table)
```

### Agent Event Types

```typescript
type AgentEventType =
  | 'text'           // agent produced text output
  | 'tool_call'      // agent invoked a tool (name, args summary)
  | 'tool_result'    // tool returned a result (summary, not full output)
  | 'thinking'       // agent is reasoning (thinking block)
  | 'turn_complete'  // one turn finished (token counts)
  | 'error'          // agent encountered an error
  | 'session_start'  // session began (session ID, agent type)
  | 'session_end'    // session finished (total tokens, duration)

interface AgentEvent {
  runId: string
  phase: string           // step ID from workflow
  role: string            // planner/coder/reviewer
  type: AgentEventType
  timestamp: string
  data: {
    text?: string         // for text events
    toolName?: string     // for tool_call events
    toolArgs?: string     // for tool_call events (summary, not full)
    tokenCount?: number   // for turn_complete events
    error?: string        // for error events
  }
}
```

### Component Changes

#### 1. StreamingExec (`src/workers/streaming-exec.ts`) — NEW

Replaces `execWithTimeout()` for worker invocations. Spawns the child process and parses stdout events as they arrive instead of buffering.

```typescript
interface StreamingExecOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  stdin?: string
  onEvent: (event: AgentEvent) => void
}

interface StreamingExecResult {
  stdout: string         // full buffered output (for backward compat)
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
}
```

**Implementation:**
- Uses Node.js `child_process.spawn` (not execa's buffered mode)
- Reads stdout line-by-line
- For Claude (`--output-format json`): parses each JSON event, emits `AgentEvent`
- For Codex (NDJSON): parses each line as JSON, emits `AgentEvent`
- Also buffers full output for the existing parse pipeline (backward compatible)
- Timeout handling via `setTimeout` + `SIGTERM`/`SIGKILL`

**Event mapping per agent:**

| Claude Event | AgentEvent Type |
|-------------|-----------------|
| `type: "system"` | `session_start` |
| `type: "assistant"` with text content | `text` |
| `type: "assistant"` with tool_use content | `tool_call` |
| `type: "result"` | `session_end` |

| Codex Event | AgentEvent Type |
|------------|-----------------|
| `type: "item.completed"` with `agent_message` | `text` |
| `type: "function_call"` or tool invocation | `tool_call` |
| Final event | `session_end` |

#### 2. EventBus (`src/events/bus.ts`) — NEW

In-process event emitter scoped per run. Subscribers register by run ID.

```typescript
class AgentEventBus {
  subscribe(runId: string, handler: (event: AgentEvent) => void): () => void
  emit(event: AgentEvent): void
  getHistory(runId: string, limit?: number): AgentEvent[]
}
```

- Uses a simple EventEmitter pattern
- Keeps a bounded in-memory ring buffer per run (last 500 events)
- Subscribers get events synchronously (no async overhead)
- Unsubscribe returns cleanup function

#### 3. Event Persistence (`src/state/migrations/008-agent-events.ts`) — NEW

```sql
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  role TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT,                    -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_events_run ON agent_events(run_id, created_at);
```

Written in batches (every 2 seconds or 50 events, whichever comes first) to avoid DB write pressure during fast event streams.

#### 4. Worker Adapter Changes

**Claude adapter:** Replace `execWithTimeout()` call with `streamingExec()`. Map Claude JSON events to `AgentEvent` in the `onEvent` callback.

**Codex adapter:** Replace `execWithTimeout()` call with `streamingExec()`. Map Codex NDJSON events to `AgentEvent`.

**ACP adapter:** Already has `onSessionUpdate` callback — extend it to emit richer `AgentEvent` types instead of just collecting text.

#### 5. TUI Enhancement (`src/cli/tui/agent-stream.tsx`) — NEW

New TUI panel that shows the live event stream for the active run:

```
┌─ Agent Activity (run JytYGYNjzgjH) ────────────────┐
│ [02:31:49] coder  session_start  codex             │
│ [02:32:15] coder  tool_call     Read src/config.ts  │
│ [02:32:18] coder  tool_call     Read src/loop/...   │
│ [02:33:01] coder  text          Implementing the... │
│ [02:34:22] coder  tool_call     Edit src/foo.ts     │
│ [02:35:10] coder  tool_call     Bash pnpm test      │
│ [02:36:45] coder  text          Tests passing, ...  │
│ [02:37:00] coder  tool_call     Edit src/bar.ts     │
│ ● streaming...                           142 events │
└─────────────────────────────────────────────────────┘
```

- Subscribes to `AgentEventBus` for the active run
- Auto-scrolls to latest event
- Truncates long text to fit terminal width
- Color-coded by event type

#### 6. MCP Tool (`night-orch-stream-events`) — NEW

```typescript
{
  name: 'night-orch-stream-events',
  description: 'Get recent agent events for an active run',
  parameters: {
    runId: { type: 'string', required: true },
    since: { type: 'number', description: 'Event ID to start from (for polling)' },
    limit: { type: 'number', default: 50 },
  },
  returns: {
    events: AgentEvent[],
    lastEventId: number,
  }
}
```

MCP clients poll this tool to get new events since their last fetch. Not true streaming (MCP doesn't support server-push in stdio mode) but sufficient for Claude Code integration.

#### 7. Session Logs (`src/workers/session-log.ts`) — NEW

Write the full agent session to a log file for post-run analysis:

```
~/.night-orch/logs/{runId}/{phase}.jsonl
```

Each line is an `AgentEvent` in JSON. Created alongside the existing checkpoint system. Useful for debugging failed runs.

### Config

```yaml
observability:
  agentStreaming: true         # default: true — emit events from agent processes
  eventRetention: 1000         # max events kept in memory per run
  sessionLogs: true            # default: true — write JSONL session logs
  sessionLogRetention: 7       # days to keep session logs
```

## Migration Path

1. **Phase A** — `StreamingExec` + `EventBus` + session logs. No TUI/MCP changes. Events are emitted and logged but not yet consumed by UI.
2. **Phase B** — TUI `agent-stream` panel. Consumes from EventBus.
3. **Phase C** — MCP `stream-events` tool. DB persistence. Retrospective analysis.

Phase A is the critical foundation. Phases B and C can ship independently after.

## Acceptance Criteria

- [ ] While a Claude worker runs, `night-orch watch` shows tool calls and text output in real time
- [ ] While a Codex worker runs, same visibility
- [ ] After a run completes, `~/.night-orch/logs/{runId}/` contains JSONL session logs
- [ ] MCP tool `night-orch-stream-events` returns recent events for an active run
- [ ] Existing worker behavior unchanged — all 863 tests still pass
- [ ] Event streaming adds <5% overhead to worker execution time

## Risks

- **Stdout parsing mid-stream**: Claude/Codex may emit partial JSON lines. The streaming parser must handle line buffering correctly.
- **DB write pressure**: High-frequency events (every few seconds) during agent execution. Batched writes mitigate this.
- **Memory**: 500-event ring buffer per run × N concurrent runs. Bounded by design.
- **Codex sub-agents**: Codex spawns sub-agents whose output isn't in the main event stream. This is a Codex limitation we can't solve — document it.
