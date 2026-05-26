import {
  run as sandcastleRun,
  claudeCode,
  codex,
  createBindMountSandboxProvider,
  type AgentProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ClaudeCodeOptions,
  type CodexOptions,
  type ExecResult,
  type RunOptions,
  type RunResult,
} from '@ai-hero/sandcastle'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { classifyAuthFailure } from './auth-check.js'
import { logger } from '../utils/logger.js'
import { emitWorkerEvent, isRecord, summarizeValue } from './events.js'
import { extractClaudeTokenUsage } from './claude.js'
import { extractCodexOutput, extractCodexTokenUsage } from './codex.js'
import { normalizePathForSubprocess } from './env.js'

const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7'
const DEFAULT_CODEX_MODEL = 'gpt-5-codex'

type SandcastleRun = (options: RunOptions) => Promise<RunResult>

export interface SandcastleBindings {
  run: SandcastleRun
  claudeCode: typeof claudeCode
  codex: typeof codex
}

export interface SandcastleWorkerAdapterOptions {
  workerType: 'claude' | 'codex'
  availabilityCommand?: string
  bindings?: SandcastleBindings
  sandboxProviderFactory?: (sandboxEnv: Record<string, string>) => BindMountSandboxProvider
}

const DEFAULT_BINDINGS: SandcastleBindings = {
  run: sandcastleRun,
  claudeCode,
  codex,
}

export class SandcastleWorkerAdapter implements WorkerAdapter {
  private readonly workerType: 'claude' | 'codex'
  private readonly availabilityCommand: string
  private readonly bindings: SandcastleBindings
  private readonly sandboxProviderFactory: (sandboxEnv: Record<string, string>) => BindMountSandboxProvider

  constructor(options: SandcastleWorkerAdapterOptions) {
    this.workerType = options.workerType
    this.availabilityCommand = options.availabilityCommand ?? options.workerType
    this.bindings = options.bindings ?? DEFAULT_BINDINGS
    this.sandboxProviderFactory = options.sandboxProviderFactory ?? createStrictHostSandboxProvider
  }

  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const start = Date.now()
    const controller = new AbortController()
    const timeoutMs = input.timeoutSeconds * 1000
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Worker timed out after ${input.timeoutSeconds}s`))
    }, timeoutMs)

    emitWorkerEvent(input, 'session_start', {
      agent: this.workerType,
      continueSessionId: input.continueSessionId ?? null,
    })

    let rawOutput = ''
    let exitCode = 0
    let timedOut = false
    let sessionId: string | null = null
    let tokenUsage: WorkerTaskResult['tokenUsage']
    let authFailure = false

    try {
      const agent = this.workerType === 'claude'
        ? buildClaudeAgent(input.profile.args, this.bindings.claudeCode)
        : buildCodexAgent(input.profile.args, input.continueSessionId, this.bindings.codex)

      const runResult = await this.bindings.run({
        agent,
        sandbox: this.sandboxProviderFactory(input.env),
        cwd: input.worktreePath,
        prompt: input.prompt,
        branchStrategy: { type: 'head' },
        maxIterations: 1,
        idleTimeoutSeconds: input.timeoutSeconds,
        resumeSession: this.workerType === 'claude'
          ? (input.continueSessionId ?? undefined)
          : undefined,
        signal: controller.signal,
        logging: {
          type: 'file',
          path: buildRunLogPath(this.workerType),
          onAgentStreamEvent: (event) => {
            if (event.type === 'text') {
              emitWorkerEvent(input, 'text', { text: event.message })
              return
            }
            if (event.type === 'toolCall') {
              emitWorkerEvent(input, 'tool_call', {
                toolName: event.name,
                toolArgs: event.formattedArgs,
              })
            }
          },
        },
      })

      rawOutput = runResult.stdout ?? ''
      sessionId = resolveSessionId(this.workerType, runResult, rawOutput)
      tokenUsage = resolveTokenUsage(this.workerType, runResult, rawOutput)
    } catch (err) {
      timedOut = controller.signal.aborted
      exitCode = timedOut ? 124 : 1
      rawOutput = formatSandcastleError(err)
      authFailure = classifyAuthFailure(rawOutput, exitCode, this.workerType).isAuthFailure
      if (!timedOut) {
        logger.warn(
          {
            role: input.role,
            workerType: this.workerType,
            message: summarizeValue(rawOutput, 400),
          },
          'Sandcastle worker invocation failed',
        )
      }
    } finally {
      clearTimeout(timeout)
    }

    const assistantText = this.workerType === 'codex'
      ? extractCodexOutput(rawOutput)
      : rawOutput

    const { parsed, parseError } = exitCode === 0
      ? parseOutput(input.role, assistantText)
      : { parsed: null, parseError: null }

    if (exitCode !== 0 && !authFailure) {
      authFailure = classifyAuthFailure(rawOutput, exitCode, this.workerType).isAuthFailure
    }

    const durationMs = Date.now() - start
    emitWorkerEvent(input, 'session_end', {
      exitCode,
      timedOut,
      durationMs,
      sessionId,
      tokenUsage,
    })

    return {
      rawOutput,
      exitCode,
      timedOut,
      durationMs,
      parsed,
      parseError,
      sessionId,
      tokenUsage,
      authFailure,
    }
  }

  async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    try {
      const result = await execWithTimeout(this.availabilityCommand, ['--version'], {
        cwd: '.',
        env: {
          PATH: normalizePathForSubprocess(process.env['PATH'], process.env['HOME']),
          HOME: process.env['HOME'] ?? '',
        },
        timeoutMs: 5000,
      })
      if (result.exitCode !== 0) {
        return { available: false, version: null }
      }
      return {
        available: true,
        version: result.stdout.trim().split('\n')[0] ?? null,
      }
    } catch {
      return { available: false, version: null }
    }
  }
}

export function createStrictHostSandboxProvider(
  sandboxEnv: Record<string, string> = {},
): BindMountSandboxProvider {
  return createBindMountSandboxProvider({
    name: 'night-orch-host-sandbox',
    env: sandboxEnv,
    create: async (options): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath
      return {
        worktreePath,
        exec: (command, execOptions) => runHostCommand(command, worktreePath, options.env, execOptions),
        copyFileIn: (hostPath, sandboxPath) => copyWithinHost(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) => copyWithinHost(sandboxPath, hostPath),
        close: async () => {},
      }
    },
  })
}

function runHostCommand(
  command: string,
  worktreePath: string,
  env: Record<string, string>,
  options?: {
    onLine?: (line: string) => void
    cwd?: string
    stdin?: string
  },
): Promise<ExecResult> {
  const cwd = options?.cwd ?? worktreePath

  const onLine = options?.onLine
  if (onLine) {
    return runStreamingCommand(command, cwd, env, {
      onLine,
      stdin: options?.stdin,
    })
  }

  return new Promise<ExecResult>((resolve, reject) => {
    const proc = execFile('sh', ['-c', command], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error instanceof Error ? error : new Error('Command execution failed'))
        return
      }

      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: typeof error?.code === 'number' ? error.code : 0,
      })
    })

    if (options?.stdin !== undefined) {
      proc.stdin?.write(options.stdin)
      proc.stdin?.end()
    }
  })
}

function runStreamingCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  options: {
    onLine: (line: string) => void
    stdin?: string
  },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env,
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    if (!proc.stdout || !proc.stderr) {
      reject(new Error('Failed to open worker stdio streams'))
      return
    }

    if (options.stdin !== undefined) {
      proc.stdin?.write(options.stdin)
      proc.stdin?.end()
    }

    const stdoutLines: string[] = []
    const stderrChunks: string[] = []

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      stdoutLines.push(line)
      options.onLine(line)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString())
    })

    proc.on('error', (error) => {
      reject(error)
    })

    proc.on('close', (code) => {
      resolve({
        stdout: stdoutLines.join('\n'),
        stderr: stderrChunks.join(''),
        exitCode: code ?? 0,
      })
    })
  })
}

async function copyWithinHost(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

function buildClaudeAgent(
  args: string[],
  builder: typeof claudeCode,
): AgentProvider {
  const model = extractFlagValue(args, ['--model', '-m']) ?? DEFAULT_CLAUDE_MODEL
  const effort = parseClaudeEffort(args)

  return builder(model, {
    env: {},
    captureSessions: false,
    ...(effort ? { effort } : {}),
  } satisfies ClaudeCodeOptions)
}

function buildCodexAgent(
  args: string[],
  continueSessionId: string | null | undefined,
  builder: typeof codex,
): AgentProvider {
  const model = extractFlagValue(args, ['--model', '-m']) ?? DEFAULT_CODEX_MODEL
  const effort = parseCodexEffort(args)

  const base = builder(model, {
    env: {},
    ...(effort ? { effort } : {}),
  } satisfies CodexOptions)

  return {
    ...base,
    buildPrintCommand(options) {
      const command = base.buildPrintCommand(options)
      if (!continueSessionId) return command
      return {
        ...command,
        command: injectCodexResumeSubcommand(command.command, continueSessionId),
      }
    },
    parseStreamLine(line: string) {
      const events = base.parseStreamLine(line).filter((event) => event.type !== 'result')
      const parsed = tryParseJson(line)
      if (isRecord(parsed) && typeof parsed['thread_id'] === 'string') {
        events.push({ type: 'session_id', sessionId: parsed['thread_id'] })
      }
      if (isRecord(parsed) && isRecord(parsed['session']) && typeof parsed['session']['thread_id'] === 'string') {
        events.push({ type: 'session_id', sessionId: parsed['session']['thread_id'] })
      }
      return events
    },
  }
}

function injectCodexResumeSubcommand(command: string, sessionId: string): string {
  if (!/^(?:\S+\s+)*codex\s+exec\b/.test(command)) return command
  const escapedSession = shellEscape(sessionId)
  return command.replace(/\bcodex\s+exec\b/, `codex exec resume ${escapedSession}`)
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function resolveSessionId(workerType: 'claude' | 'codex', result: RunResult, rawOutput: string): string | null {
  const last = result.iterations.at(-1)?.sessionId
  if (last) return last
  if (workerType === 'codex') {
    return extractCodexThreadId(rawOutput)
  }
  return null
}

function resolveTokenUsage(
  workerType: 'claude' | 'codex',
  result: RunResult,
  rawOutput: string,
): WorkerTaskResult['tokenUsage'] {
  const usage = result.iterations.at(-1)?.usage
  if (usage) {
    const promptTokens = usage.inputTokens + usage.cacheCreationInputTokens
    const completionTokens = usage.outputTokens
    const cacheReadTokens = usage.cacheReadInputTokens
    if (promptTokens > 0 || completionTokens > 0 || cacheReadTokens > 0) {
      return {
        promptTokens,
        completionTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      }
    }
  }

  if (workerType === 'codex') {
    return extractCodexTokenUsage(rawOutput)
  }

  return extractClaudeTokenUsage(rawOutput)
}

function parseOutput(role: string, raw: string): { parsed: WorkerTaskResult['parsed']; parseError: string | null } {
  switch (role) {
    case 'planner': {
      const { result, error } = parsePlannerOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'coder': {
      const { result, error } = parseCoderOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'reviewer': {
      const { result, error } = parseReviewerOutput(raw)
      return { parsed: result, parseError: error }
    }
    default:
      return { parsed: null, parseError: `Unknown role: ${role}` }
  }
}

function parseClaudeEffort(args: string[]): ClaudeCodeOptions['effort'] | undefined {
  const effort = extractFlagValue(args, ['--effort'])
  if (!effort) return undefined
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return effort
  }
  return undefined
}

function parseCodexEffort(args: string[]): CodexOptions['effort'] | undefined {
  const direct = extractFlagValue(args, ['--effort'])
  if (isCodexEffort(direct)) return direct

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg !== '-c' && arg !== '--config') continue
    const value = args[i + 1]
    if (!value) continue
    const match = value.match(/model_reasoning_effort\s*=\s*"?([a-z]+)"?/i)
    if (!match) continue
    const parsed = match[1]?.toLowerCase()
    if (isCodexEffort(parsed)) return parsed
  }

  return undefined
}

function isCodexEffort(value: string | undefined): value is NonNullable<CodexOptions['effort']> {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
}

function extractFlagValue(args: string[], flagNames: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue

    for (const flag of flagNames) {
      if (arg === flag) {
        const value = args[i + 1]
        if (value) return value
      }
      if (arg.startsWith(`${flag}=`)) {
        const [, value] = arg.split('=', 2)
        if (value) return value
      }
    }
  }
  return undefined
}

function extractCodexThreadId(raw: string): string | null {
  const events = parseCodexEvents(raw)
  for (const event of events) {
    if (!isRecord(event)) continue
    if (typeof event['thread_id'] === 'string') return event['thread_id']
    if (typeof event['id'] === 'string' && event['object'] === 'thread') return event['id']
    if (isRecord(event['session']) && typeof event['session']['thread_id'] === 'string') {
      return event['session']['thread_id']
    }
  }
  return null
}

function parseCodexEvents(raw: string): unknown[] {
  const trimmed = raw.trim()

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to line-by-line parsing.
    }
  }

  const events: unknown[] = []
  for (const line of raw.split('\n')) {
    const parsed = tryParseJson(line.trim())
    if (parsed) events.push(parsed)
  }
  return events
}

function tryParseJson(value: string): unknown | null {
  if (!value.startsWith('{') && !value.startsWith('[')) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function formatSandcastleError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.trim().length > 0) return error.message
    return error.toString()
  }
  return String(error)
}

function buildRunLogPath(workerType: 'claude' | 'codex'): string {
  return join(tmpdir(), 'night-orch-sandcastle', `${workerType}-${randomUUID()}.log`)
}
