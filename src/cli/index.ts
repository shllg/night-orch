#!/usr/bin/env node
import { Command } from 'commander'
import { logger } from '../utils/logger.js'
import { sanitizeError } from '../utils/sanitize-error.js'
import { getBuildInfo } from '../utils/build-info.js'
import { doctorCommand } from './commands/doctor.js'

// Install process-level error handlers before any top-level async work
// starts. Night-orch is a long-lived daemon with many floating promises
// (TUI keybindings, poll-loop fan-outs, web request handlers); without
// these, a single unhandled rejection would terminate the daemon with
// no diagnostic beyond Node's default message. We log via pino (which
// redacts credentials) and exit with a non-zero code so the system
// supervisor (systemd, launchd, pm2) can restart us cleanly.
//
// Exit-on-crash intentionally matches the supervisor pattern used for
// sub-processes in src/supervisor/index.ts — any transient fault is
// better handled by a full daemon restart than by swallowing the
// rejection and continuing in an unknown state.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: sanitizeError(reason) }, 'Unhandled promise rejection — exiting')
  // Give pino a tick to flush before exit.
  setTimeout(() => process.exit(1), 50).unref()
})
process.on('uncaughtException', (err) => {
  logger.error({ err: sanitizeError(err) }, 'Uncaught exception — exiting')
  setTimeout(() => process.exit(1), 50).unref()
})
import { runCommand } from './commands/run.js'
import { runOnceCommand } from './commands/run-once.js'
import { syncCommand } from './commands/sync.js'
import { retryCommand } from './commands/retry.js'
import { cleanupCommand } from './commands/cleanup.js'
import { notifyTestCommand } from './commands/notify-test.js'
import { mcpCommand } from './commands/mcp.js'
import { labelsInitCommand } from './commands/labels-init.js'
import { statusCommand } from './commands/status.js'
import { deleteEntryCommand } from './commands/delete-entry.js'
import { runInit } from './commands/init.js'
import { runWatch } from './commands/watch.js'
import { webCommand } from './commands/web.js'
import { serveCommand } from './commands/serve.js'
import { updateCommand } from './commands/update.js'
import { continueCommand } from './commands/continue.js'
import { costOverrideCommand } from './commands/cost-override.js'
import { dailyCostOverrideCommand } from './commands/daily-cost-override.js'
import {
  settingsListCommand,
  settingsSetCommand,
  settingsUnsetCommand,
} from './commands/settings.js'
import {
  monitoringInitCommand,
  monitoringUpCommand,
  monitoringDownCommand,
  monitoringLogsCommand,
} from './commands/monitoring.js'

const program = new Command()

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value]
}

interface GlobalCliOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

function resolveRootGlobalOpts(cmd: Command): GlobalCliOpts | undefined {
  return cmd.parent?.parent?.opts<GlobalCliOpts>()
}

program
  .name('night-orch')
  .description('Nightly GitHub/Forgejo issue orchestrator — autonomous AI agent coding tool')
  .version(getBuildInfo().version)
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
  .option('--project <repo>', 'Validate a specific target project (owner/name)')
  .action((opts, cmd) => doctorCommand({ ...cmd.parent?.opts(), ...opts }))

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
  .command('delete')
  .argument('<repo>', 'Repository (owner/name)')
  .argument('<issue-number>', 'Issue number')
  .option('--force', 'Delete even when the issue currently has a running run')
  .description('Delete one local issue entry (runs, issue state, worktree, lease) so it can be rediscovered fresh')
  .action((repo, issueNumber, opts, cmd) => deleteEntryCommand(repo, issueNumber, { ...cmd.parent?.opts(), ...opts }))

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
  .command('continue')
  .argument('<repo>', 'Repository (owner/name)')
  .argument('<issue-number>', 'Issue number')
  .description('Queue a context-aware continue pass for blocked/review_ready/error work')
  .action((repo, issueNumber, _opts, cmd) => continueCommand(repo, issueNumber, cmd.parent?.opts()))

program
  .command('cost-override')
  .argument('<repo>', 'Repository (owner/name)')
  .argument('<issue-number>', 'Issue number')
  .argument('[amount]', 'Override budget in USD (positive number). Omit with --clear.')
  .option('--clear', 'Remove any existing cost override from the latest run')
  .description(
    'Grant a cost budget override to the latest run for an issue. ' +
      'The override replaces the per-run cap and exempts the run from the daily cap.',
  )
  .action((repo, issueNumber, amount, opts, cmd) =>
    costOverrideCommand(repo, issueNumber, amount, { ...cmd.parent?.opts(), ...opts }),
  )

program
  .command('daily-cost-override')
  .argument('[amount]', 'Override daily cap in USD (positive number). Omit with --clear.')
  .option('--clear', "Remove today's daily cost cap override")
  .description(
    "Raise today's daily cost cap. Auto-expires at 00:00 UTC. " +
      'Use this when the whole day is blocked and per-run overrides would be impractical.',
  )
  .action((amount, opts, cmd) =>
    dailyCostOverrideCommand(amount, { ...cmd.parent?.opts(), ...opts }),
  )

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
  .description('Interactive TUI with poll/sync/cleanup and issue actions')
  .action((_opts, cmd) => runWatch(cmd.parent?.opts()))

program
  .command('web')
  .description('Run embedded REST + WebSocket web interface (attach mode by default)')
  .option('--host <host>', 'Web server bind host', '127.0.0.1')
  .option(
    '--allowed-host <host>',
    'Allowed Host/Origin hostname for web API + websocket requests (repeatable)',
    collectOptionValue,
    [] as string[],
  )
  .option('--port <port>', 'Web server port', '3200')
  .option('--snapshot-interval-ms <ms>', 'WebSocket snapshot interval in milliseconds', '3000')
  .option('--standalone', 'Run poller + metrics + embedded MCP in this process')
  .action((opts: { host?: string; allowedHost?: string[]; port?: string; snapshotIntervalMs?: string; standalone?: boolean }, cmd) => webCommand({
    host: opts.host,
    allowedHost: opts.allowedHost,
    port: opts.port,
    snapshotIntervalMs: opts.snapshotIntervalMs,
    standalone: opts.standalone,
  }, cmd.parent?.opts()))

program
  .command('serve')
  .description('Run supervisor — manages both poller and web server, supports self-update')
  .option('--web-host <host>', 'Web server bind host', '127.0.0.1')
  .option('--web-port <port>', 'Web server port', '3200')
  .option(
    '--allowed-host <host>',
    'Allowed Host/Origin hostname for web requests (repeatable)',
    collectOptionValue,
    [] as string[],
  )
  .action((opts: { webHost?: string; webPort?: string; allowedHost?: string[] }, cmd) =>
    serveCommand(
      { webHost: opts.webHost, webPort: opts.webPort, allowedHost: opts.allowedHost },
      cmd.parent?.opts(),
    ),
  )

program
  .command('update')
  .description('Trigger self-update — pulls latest code, rebuilds, and restarts services')
  .action((_opts, cmd) => updateCommand(cmd.parent?.opts()))

const settingsCommand = program
  .command('settings')
  .description('Manage DB-backed runtime settings overrides')

settingsCommand
  .command('list')
  .description('List runtime settings and active overrides')
  .option('--json', 'Output JSON')
  .action((opts: { json?: boolean }, cmd) => {
    const globalOpts = resolveRootGlobalOpts(cmd)
    return settingsListCommand(globalOpts, opts.json ?? false)
  })

settingsCommand
  .command('set')
  .argument('<key>', 'Setting key')
  .argument('<value>', 'Setting value')
  .description('Set one runtime setting override')
  .action((key: string, value: string, _opts, cmd) => {
    const globalOpts = resolveRootGlobalOpts(cmd)
    return settingsSetCommand(key, value, globalOpts)
  })

settingsCommand
  .command('unset')
  .argument('<key>', 'Setting key')
  .description('Clear one runtime setting override')
  .action((key: string, _opts, cmd) => {
    const globalOpts = resolveRootGlobalOpts(cmd)
    return settingsUnsetCommand(key, globalOpts)
  })

const monitoringCommand = program
  .command('monitoring')
  .description('Manage the Prometheus + Grafana monitoring stack')

monitoringCommand
  .command('init')
  .description('Extract bundled monitoring configs (docker-compose, Prometheus, Grafana)')
  .option('--dir <path>', 'Target directory', undefined)
  .option('--force', 'Overwrite existing files')
  .action((opts: { dir?: string; force?: boolean }) => monitoringInitCommand(opts))

monitoringCommand
  .command('up')
  .description('Start the monitoring stack (docker compose up -d)')
  .option('--dir <path>', 'Monitoring directory', undefined)
  .action((opts: { dir?: string }) => monitoringUpCommand(opts))

monitoringCommand
  .command('down')
  .description('Stop the monitoring stack (docker compose down)')
  .option('--dir <path>', 'Monitoring directory', undefined)
  .action((opts: { dir?: string }) => monitoringDownCommand(opts))

monitoringCommand
  .command('logs')
  .description('Tail monitoring stack logs')
  .option('--dir <path>', 'Monitoring directory', undefined)
  .action((opts: { dir?: string }) => monitoringLogsCommand(opts))

program.parse()
