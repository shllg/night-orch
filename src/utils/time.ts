const SQLITE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/
const HAS_TZ_SUFFIX_RE = /(Z|[+-]\d{2}:\d{2})$/i

export function nowUtcIso(): string {
  return new Date().toISOString()
}

export function utcIsoFromMs(ms: number): string {
  return new Date(ms).toISOString()
}

export function utcDayKey(timestamp = nowUtcIso()): string {
  return timestamp.slice(0, 10)
}

export function parseUtcTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const normalized = normalizeUtcTimestamp(value)
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function formatUtcClock(value: string | null | undefined): string {
  const parsed = parseUtcTimestampMs(value)
  if (!Number.isFinite(parsed)) return '--:--:-- UTC'
  return `${utcIsoFromMs(parsed).slice(11, 19)} UTC`
}

export function formatUtcDateTime(value: string | null | undefined): string {
  const parsed = parseUtcTimestampMs(value)
  if (!Number.isFinite(parsed)) return 'invalid UTC timestamp'
  return `${utcIsoFromMs(parsed).slice(0, 19).replace('T', ' ')} UTC`
}

function normalizeUtcTimestamp(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed

  if (HAS_TZ_SUFFIX_RE.test(trimmed)) {
    return trimmed
  }

  if (SQLITE_TIMESTAMP_RE.test(trimmed)) {
    return `${trimmed.replace(' ', 'T')}Z`
  }

  if (ISO_TIMESTAMP_RE.test(trimmed)) {
    return `${trimmed}Z`
  }

  return trimmed
}
