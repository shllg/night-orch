import { normalizeRunStatus } from '../../components/issue-row/view-model.js'
import type { TabId } from './types.js'

export const TABS: Array<{ id: TabId; hotkey: string; label: string }> = [
  { id: 'runs', hotkey: '1', label: 'Issues' },
  { id: 'projects', hotkey: '2', label: 'Projects' },
  { id: 'stats', hotkey: '3', label: 'Stats' },
  { id: 'logs', hotkey: '4', label: 'Logs' },
  { id: 'settings', hotkey: '5', label: 'Settings' },
  { id: 'fileloop', hotkey: '6', label: 'File-Loop' },
]

export type TuiColor = 'white' | 'gray' | 'yellow' | 'cyan' | 'magenta' | 'green' | 'red'

export const STATUS_COLORS: Record<ReturnType<typeof normalizeRunStatus>, TuiColor> = {
  running: 'yellow',
  queued: 'cyan',
  review_ready: 'magenta',
  completed: 'green',
  blocked: 'red',
  error: 'red',
}

export const EVENT_COLORS: Record<string, TuiColor> = {
  session_start: 'green',
  session_end: 'green',
  text: 'gray',
  tool_call: 'cyan',
  tool_result: 'magenta',
  thinking: 'yellow',
  turn_complete: 'yellow',
  error: 'red',
}

const PHASE_COLORS: Record<string, TuiColor> = {
  queued: 'cyan',
  plan: 'cyan',
  planner: 'cyan',
  planning: 'cyan',
  code: 'yellow',
  coder: 'yellow',
  review: 'magenta',
  reviewer: 'magenta',
  verify: 'green',
  verification: 'green',
  publish: 'green',
  merge: 'green',
  merged: 'green',
}

export function colorForRunStatus(status: string): TuiColor {
  const normalized = status.trim().toLowerCase()
  if (
    normalized !== 'queued'
    && normalized !== 'running'
    && normalized !== 'review_ready'
    && normalized !== 'completed'
    && normalized !== 'blocked'
    && normalized !== 'error'
  ) {
    return 'white'
  }
  return STATUS_COLORS[normalizeRunStatus(status)] ?? 'white'
}

export function colorForPhase(phase: string | null | undefined): TuiColor {
  const normalized = normalizeLabel(phase)
  if (!normalized) return 'gray'

  const direct = PHASE_COLORS[normalized]
  if (direct) return direct

  const tokens = normalized.split(/[\s:_-]+/)
  for (const token of tokens) {
    const tokenColor = PHASE_COLORS[token]
    if (tokenColor) return tokenColor
  }

  if (tokens.some((token) => token.includes('error') || token.includes('fail') || token.includes('block'))) {
    return 'red'
  }
  if (tokens.some((token) => token.includes('queue') || token.includes('wait') || token.includes('pending'))) {
    return 'cyan'
  }
  if (tokens.some((token) => token.includes('review'))) return 'magenta'
  if (tokens.some((token) => token.includes('plan'))) return 'cyan'
  if (tokens.some((token) => token.includes('code') || token.includes('implement') || token.includes('fix'))) {
    return 'yellow'
  }
  if (tokens.some((token) => token.includes('verify') || token.includes('test') || token.includes('check'))) {
    return 'green'
  }
  if (tokens.some((token) => token.includes('publish') || token.includes('merge') || token.includes('release'))) {
    return 'green'
  }

  return 'white'
}

export function colorForPrNumber(prNumber: number | null | undefined): TuiColor {
  return typeof prNumber === 'number' ? 'cyan' : 'gray'
}

export function colorForIterationCount(iterationCount: number | null | undefined): TuiColor {
  const iteration = iterationCount ?? 0
  if (iteration <= 1) return 'green'
  if (iteration <= 2) return 'yellow'
  return 'red'
}

export function colorForCostUsd(costUsd: number | null | undefined): TuiColor {
  const cost = costUsd ?? 0
  if (cost <= 0) return 'gray'
  if (cost < 0.5) return 'green'
  if (cost < 2) return 'yellow'
  return 'red'
}

function normalizeLabel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}
