#!/usr/bin/env node
import { Command } from 'commander'
import { doctorCommand } from './commands/doctor.js'
import { runCommand } from './commands/run.js'
import { runOnceCommand } from './commands/run-once.js'
import { syncCommand } from './commands/sync.js'
import { retryCommand } from './commands/retry.js'
import { cleanupCommand } from './commands/cleanup.js'
import { notifyTestCommand } from './commands/notify-test.js'
import { mcpCommand } from './commands/mcp.js'
import { labelsInitCommand } from './commands/labels-init.js'
import { statusCommand } from './commands/status.js'
import { runInit } from './commands/init.js'
import { runWatch } from './commands/watch.js'
import { webCommand } from './commands/web.js'

const program = new Command()

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value]
}

program
  .name('night-orch')
  .description('Nightly GitHub/Forgejo issue orchestrator — autonomous AI agent coding tool')
  .version('0.1.0')
  .option('-c, --config <path>', 'Path to config YAML file')
  .option('--trust-workspace', 'Allow loading .night-orch.yaml/.yml from the current directory')
  .option('--dry-run', 'Show what would happen without making changes')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .action(async (_opts, cmd) => {
    await runWatch(cmd.opts())
  })

program
  .command('run')
  .description('Headless long-running poller — poll GitHub on interval and process eligible issues')
  .action((_opts, cmd) => runCommand(cmd.parent?.opts()))

program
  .command('run-once')
  .description('Single poll + process cycle — useful for testing')
  .action((_opts, cmd) => runOnceCommand(cmd.parent?.opts()))

program
  .command('doctor')
  .description('Check configuration, auth, CLI binaries, repo paths, and DB')
  .action((_opts, cmd) => doctorCommand(cmd.parent?.opts()))

program
  .command('sync')
  .description('Reconcile local state with GitHub (merged PRs, closed issues, label changes)')
  .action((_opts, cmd) => syncCommand(cmd.parent?.opts()))

program
  .command('retry')
  .argument('<repo>', 'Repository (owner/name)')
  .argument('<issue-number>', 'Issue number')
  .option('--immediate', 'Process immediately instead of queuing for next poll')
  .option('--reset-plan', 'Discard prior plan and start fresh')
  .option('--fresh', 'Reset branch to base and re-implement from scratch (use after merge conflicts)')
  .description('Force a re-run of one task')
  .action((repo, issueNumber, opts, cmd) => retryCommand(repo, issueNumber, { ...cmd.parent?.opts(), ...opts }))

program
  .command('rebase')
  .argument('<repo>', 'Repository (owner/name)')
  .argument('<issue-number>', 'Issue number')
  .description('Queue issue for rebase onto latest base, verify, and fix if needed')
  .action(async (repo, issueNumber, _opts, cmd) => {
    const { rebaseCommand } = await import('./commands/rebase.js')
    await rebaseCommand(repo, issueNumber, cmd.parent?.opts())
  })

program
  .command('cleanup')
  .description('Clean stale worktrees, expired leases, and old logs')
  .action((_opts, cmd) => cleanupCommand(cmd.parent?.opts()))

program
  .command('notify-test')
  .description('Send a test notification through all configured channels')
  .action((_opts, cmd) => notifyTestCommand(cmd.parent?.opts()))

program
  .command('mcp')
  .description('Start MCP server (stdio transport) for remote control from Claude Code')
  .action((_opts, cmd) => mcpCommand(cmd.parent?.opts()))

program
  .command('status')
  .description('Show active runs, recent history, costs, and leases')
  .action((_opts, cmd) => statusCommand(cmd.parent?.opts()))

program
  .command('labels-init')
  .argument('[repo]', 'Repository (owner/name) from config; defaults to all configured repos')
  .description('Create or update issue labels from per-repo label configuration via gh CLI')
  .action((repo, _opts, cmd) => labelsInitCommand(repo, cmd.parent?.opts()))

program
  .command('init')
  .description('Interactive setup wizard')
  .action(async () => {
    await runInit()
  })

program
  .command('tui')
  .description('Interactive monitoring TUI (run `night-orch run` in a separate process)')
  .action((_opts, cmd) => runWatch(cmd.parent?.opts()))

program
  .command('web')
  .description('Run poller with embedded REST + WebSocket web interface')
  .option('--host <host>', 'Web server bind host', '127.0.0.1')
  .option(
    '--allowed-host <host>',
    'Allowed Host/Origin hostname for web API + websocket requests (repeatable)',
    collectOptionValue,
    [] as string[],
  )
  .option('--port <port>', 'Web server port', '3200')
  .option('--snapshot-interval-ms <ms>', 'WebSocket snapshot interval in milliseconds', '3000')
  .action((opts: { host?: string; allowedHost?: string[]; port?: string; snapshotIntervalMs?: string }, cmd) => webCommand({
    host: opts.host,
    allowedHost: opts.allowedHost,
    port: opts.port,
    snapshotIntervalMs: opts.snapshotIntervalMs,
  }, cmd.parent?.opts()))

program.parse()
