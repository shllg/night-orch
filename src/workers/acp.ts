import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { logger } from '../utils/logger.js'
import { loadAcpxRuntime } from './acpx-imports.js'
import { emitWorkerEvent, isRecord, summarizeValue } from './events.js'

export class AcpWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const start = Date.now()
    let assistantText = ''
    let sessionId: string | null = null
    let exitCode = 0
    let timedOut = false
    let tokenUsage: WorkerTaskResult['tokenUsage']

    const textParts: string[] = []
    emitWorkerEvent(input, 'session_start', {
      agent: 'acp',
      continueSessionId: input.continueSessionId ?? null,
    })

    const onSessionUpdate = (notification: Record<string, unknown>): void => {
      emitAcpUpdateEvent(notification, input)
      const usageFromUpdate = extractAcpTokenUsageFromNotification(notification)
      if (usageFromUpdate) {
        const isTurnComplete = notification['type'] === 'turn_complete'
        tokenUsage = mergeTokenUsage(tokenUsage, usageFromUpdate, isTurnComplete ? 'sum-completion' : 'max')
      }
      if (notification['type'] === 'text' && typeof notification['text'] === 'string') {
        textParts.push(notification['text'])
      }
    }

    try {
      const runtime = await loadAcpxRuntime()

      if (input.continueSessionId) {
        try {
          const result = await runtime.sendSessionDirect({
            sessionId: input.continueSessionId,
            prompt: input.prompt,
            env: input.env,
            permissionMode: 'approve-all',
            onSessionUpdate,
            timeoutMs: input.timeoutSeconds * 1000,
          })
          sessionId = typeof result['sessionId'] === 'string' ? result['sessionId'] : null
          tokenUsage = mergeTokenUsage(tokenUsage, extractAcpTokenUsageFromResult(result), 'max')
          assistantText = textParts.join('')
        } catch (resumeErr) {
          logger.warn({ role: input.role, err: resumeErr }, 'Session resume failed — falling back to runOnce')
          textParts.length = 0
          const result = await runtime.runOnce({
            agentCommand: input.profile.command,
            cwd: input.worktreePath,
            prompt: input.prompt,
            env: input.env,
            permissionMode: 'approve-all',
            nonInteractivePermissions: 'deny',
            timeoutMs: input.timeoutSeconds * 1000,
            onSessionUpdate,
            sessionOptions: { maxTurns: 50 },
          })
          sessionId = typeof result['sessionId'] === 'string' ? result['sessionId'] : null
          tokenUsage = mergeTokenUsage(tokenUsage, extractAcpTokenUsageFromResult(result), 'max')
          assistantText = textParts.join('')
        }
      } else {
        const result = await runtime.runOnce({
          agentCommand: input.profile.command,
          cwd: input.worktreePath,
          prompt: input.prompt,
          env: input.env,
          permissionMode: 'approve-all',
          nonInteractivePermissions: 'deny',
          timeoutMs: input.timeoutSeconds * 1000,
          onSessionUpdate,
          sessionOptions: { maxTurns: 50 },
        })
        sessionId = typeof result['sessionId'] === 'string' ? result['sessionId'] : null
        tokenUsage = mergeTokenUsage(tokenUsage, extractAcpTokenUsageFromResult(result), 'max')
        assistantText = textParts.join('')
      }
    } catch (err) {
      const durationMs = Date.now() - start
      if (isAcpTimeout(err)) timedOut = true
      exitCode = 1
      logger.error({ role: input.role, err }, 'ACP worker failed')
      emitWorkerEvent(input, 'error', { error: summarizeValue(err) })
      emitWorkerEvent(input, 'session_end', {
        exitCode,
        timedOut,
        durationMs,
        sessionId,
      })
      return {
        rawOutput: assistantText || textParts.join(''),
        exitCode,
        timedOut,
        durationMs,
        parsed: null,
        parseError: String(err),
        sessionId,
        tokenUsage,
      }
    }

    const durationMs = Date.now() - start
    if (!assistantText) assistantText = textParts.join('')
    if (!tokenUsage && assistantText.trim().length > 0) {
      logger.warn(
        {
          runId: input.runId ?? null,
          role: input.role,
          phase: input.phase ?? null,
        },
        'ACP token extraction unavailable; falling back to duration-based cost estimate',
      )
    }

    logger.info(
      { role: input.role, textLength: assistantText.length, sessionId, durationMs },
      'ACP worker completed',
    )

    const { parsed, parseError } = parseOutput(input.role, assistantText)

    emitWorkerEvent(input, 'session_end', {
      exitCode,
      timedOut,
      durationMs,
      sessionId,
    })

    return {
      rawOutput: assistantText,
      exitCode,
      timedOut,
      durationMs,
      parsed,
      parseError,
      sessionId,
      tokenUsage,
    }
  }

  async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    try {
      await loadAcpxRuntime()
      return { available: true, version: null }
    } catch {
      return { available: false, version: null }
    }
  }
}

function isAcpTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as Record<string, unknown>)['outputCode'] === 'TIMEOUT'
}

function emitAcpUpdateEvent(notification: Record<string, unknown>, input: WorkerTaskInput): void {
  const type = notification['type']

  if (type === 'text' && typeof notification['text'] === 'string') {
    emitWorkerEvent(input, 'text', { text: notification['text'] })
    return
  }

  if (type === 'thinking' && typeof notification['text'] === 'string') {
    emitWorkerEvent(input, 'thinking', { text: notification['text'] })
    return
  }

  if ((type === 'tool_call' || type === 'tool_use') && typeof notification['toolName'] === 'string') {
    emitWorkerEvent(input, 'tool_call', {
      toolName: notification['toolName'],
      toolArgs: summarizeValue(notification['toolArgs']),
    })
    return
  }

  if (type === 'tool_result') {
    emitWorkerEvent(input, 'tool_result', { text: summarizeValue(notification['result']) })
    return
  }

  if (type === 'turn_complete') {
    const tokenCount = typeof notification['tokenCount'] === 'number'
      ? notification['tokenCount']
      : undefined
    emitWorkerEvent(input, 'turn_complete', { tokenCount })
    return
  }

  if (type === 'error') {
    emitWorkerEvent(input, 'error', { error: summarizeValue(notification['error']) })
    return
  }

  if (isRecord(notification['event'])) {
    emitWorkerEvent(input, 'text', { text: summarizeValue(notification['event']) })
  }
}

function parseOutput(
  role: string,
  raw: string,
): { parsed: WorkerTaskResult['parsed']; parseError: string | null } {
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

function extractAcpTokenUsageFromNotification(notification: Record<string, unknown>): WorkerTaskResult['tokenUsage'] {
  const directUsage = tokenUsageFromCandidate(notification['usage'])
  if (directUsage) return directUsage

  const eventUsage = tokenUsageFromCandidate(notification['event'])
  if (eventUsage) return eventUsage

  if (notification['sessionUpdate'] === 'usage_update') {
    const usageUpdate = tokenUsageFromCandidate(notification)
    if (usageUpdate) return usageUpdate
  }

  if (notification['type'] === 'turn_complete') {
    const tokenCount = parseTokenCount(notification['tokenCount'])
    if (tokenCount > 0) {
      return {
        promptTokens: 0,
        completionTokens: tokenCount,
      }
    }
  }

  return undefined
}

function extractAcpTokenUsageFromResult(result: Record<string, unknown>): WorkerTaskResult['tokenUsage'] {
  const directUsage = tokenUsageFromCandidate(result['usage'])
  if (directUsage) return directUsage

  const record = result['record']
  if (isRecord(record)) {
    const cumulative = tokenUsageFromCandidate(record['cumulative_token_usage'])
    if (cumulative) return cumulative
    const requestUsage = record['request_token_usage']
    if (isRecord(requestUsage)) {
      let merged: WorkerTaskResult['tokenUsage']
      for (const value of Object.values(requestUsage)) {
        merged = mergeTokenUsage(merged, tokenUsageFromCandidate(value), 'max')
      }
      if (merged) return merged
    }
  }

  return undefined
}

function tokenUsageFromCandidate(candidate: unknown): WorkerTaskResult['tokenUsage'] {
  if (!isRecord(candidate)) return undefined

  const usageMeta = candidate['_meta']
  const source = isRecord(usageMeta) && isRecord(usageMeta['usage'])
    ? usageMeta['usage']
    : candidate

  const promptTokens = parseTokenCount(
    source['input_tokens']
      ?? source['inputTokens']
      ?? source['cache_creation_input_tokens']
      ?? source['cacheCreationInputTokens'],
  )
  const completionTokens = parseTokenCount(source['output_tokens'] ?? source['outputTokens'])
  const cacheReadTokens = parseTokenCount(
    source['cache_read_input_tokens']
      ?? source['cacheReadInputTokens']
      ?? source['cachedReadTokens'],
  )

  const promptFromSource = parseTokenCount(source['input_tokens'] ?? source['inputTokens'])
    + parseTokenCount(source['cache_creation_input_tokens'] ?? source['cacheCreationInputTokens'])
  const normalizedPromptTokens = promptFromSource > 0 ? promptFromSource : promptTokens

  if (normalizedPromptTokens <= 0 && completionTokens <= 0 && cacheReadTokens <= 0) return undefined

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  }
}

function mergeTokenUsage(
  existing: WorkerTaskResult['tokenUsage'],
  incoming: WorkerTaskResult['tokenUsage'],
  strategy: 'max' | 'sum-completion',
): WorkerTaskResult['tokenUsage'] {
  if (!incoming) return existing
  if (!existing) return incoming

  const existingCache = existing.cacheReadTokens ?? 0
  const incomingCache = incoming.cacheReadTokens ?? 0

  if (strategy === 'sum-completion') {
    const completionTokens = existing.completionTokens + incoming.completionTokens
    const promptTokens = Math.max(existing.promptTokens, incoming.promptTokens)
    const cacheReadTokens = Math.max(existingCache, incomingCache)
    return {
      promptTokens,
      completionTokens,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    }
  }

  const promptTokens = Math.max(existing.promptTokens, incoming.promptTokens)
  const completionTokens = Math.max(existing.completionTokens, incoming.completionTokens)
  const cacheReadTokens = Math.max(existingCache, incomingCache)
  return {
    promptTokens,
    completionTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  }
}

function parseTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}
