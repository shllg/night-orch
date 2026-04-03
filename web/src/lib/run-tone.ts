import { type RunStatus } from '../types/dashboard.js'

type TuiColor = 'white' | 'gray' | 'yellow' | 'cyan' | 'magenta' | 'green' | 'red'

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

export const STATUS_BADGE_TONE: Record<RunStatus, string> = {
  running: 'badge-warning',
  queued: 'badge-info',
  review_ready: 'badge-secondary',
  completed: 'badge-success',
  blocked: 'badge-error',
  error: 'badge-error',
}

export function badgeToneForPhase(phase: string | null | undefined): string {
  return badgeToneFromTuiColor(colorForPhase(phase))
}

export function badgeToneForIterationCount(iterationCount: number | null | undefined): string {
  return badgeToneFromTuiColor(colorForIterationCount(iterationCount))
}

export function badgeToneForCostUsd(costUsd: number | null | undefined): string {
  return badgeToneFromTuiColor(colorForCostUsd(costUsd))
}

export function badgeToneForPrNumber(prNumber: number | null | undefined): string {
  return badgeToneFromTuiColor(colorForPrNumber(prNumber))
}

function colorForPhase(phase: string | null | undefined): TuiColor {
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

function colorForPrNumber(prNumber: number | null | undefined): TuiColor {
  return typeof prNumber === 'number' ? 'cyan' : 'gray'
}

function colorForIterationCount(iterationCount: number | null | undefined): TuiColor {
  const iteration = iterationCount ?? 0
  if (iteration <= 1) return 'green'
  if (iteration <= 2) return 'yellow'
  return 'red'
}

function colorForCostUsd(costUsd: number | null | undefined): TuiColor {
  const cost = costUsd ?? 0
  if (cost <= 0) return 'gray'
  if (cost < 0.5) return 'green'
  if (cost < 2) return 'yellow'
  return 'red'
}

function normalizeLabel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function badgeToneFromTuiColor(color: TuiColor): string {
  switch (color) {
    case 'red':
      return 'badge-error'
    case 'yellow':
      return 'badge-warning'
    case 'cyan':
      return 'badge-info'
    case 'magenta':
      return 'badge-secondary'
    case 'green':
      return 'badge-success'
    case 'gray':
      return 'badge-neutral'
    default:
      return 'badge-ghost'
  }
}
