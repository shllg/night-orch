import { nowUtcIso } from '../utils/time.js'

export interface NdjsonEvent {
  event: string
  mode: 'run' | 'run-once'
  ts: string
  [key: string]: unknown
}

export type NdjsonWrite = (event: string, payload?: Record<string, unknown>) => void

export function createNdjsonWriter(enabled: boolean, mode: NdjsonEvent['mode']): NdjsonWrite {
  if (!enabled) return () => {}

  return (event, payload = {}) => {
    const line: NdjsonEvent = {
      event,
      mode,
      ts: nowUtcIso(),
      ...payload,
    }
    process.stdout.write(`${JSON.stringify(line)}\n`)
  }
}

export function ndjsonError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
