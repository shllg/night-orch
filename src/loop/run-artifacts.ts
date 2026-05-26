import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../utils/logger.js'

const RUNS_DIR_REL = 'runs'
const PHASES_DIR = 'phases'
const EVENTS_FILE = 'events.jsonl'
const META_FILE = 'meta.json'

export interface CreateRunArtifactsArgs {
  logsRoot: string
  runId: string
}

export interface RunArtifactPath {
  path: string
  pathRel: string
}

export interface RunArtifacts {
  logsRoot: string
  runId: string
  runRoot: string
  runRootRel: string
  eventsPath: string
  eventsPathRel: string
  phaseRoot: string
  phaseRootRel: string
  metaPath: string
  metaPathRel: string
  ensureRunRoot(): void
  ensurePhaseRoot(): void
  phasePath(phase: string): RunArtifactPath
}

export interface RunArtifactEvent {
  runId: string
  phase: string
  eventType: string
  data: Record<string, unknown> | null
  timestamp: string
}

export interface RunArtifactEventWriter {
  recordPhaseEvent(event: RunArtifactEvent): void
}

export function createRunArtifacts(args: CreateRunArtifactsArgs): RunArtifacts {
  const runRootRel = rel(RUNS_DIR_REL, args.runId)
  const runRoot = abs(args.logsRoot, runRootRel)
  const eventsPathRel = rel(runRootRel, EVENTS_FILE)
  const phaseRootRel = rel(runRootRel, PHASES_DIR)
  const metaPathRel = rel(runRootRel, META_FILE)

  return {
    logsRoot: args.logsRoot,
    runId: args.runId,
    runRoot,
    runRootRel,
    eventsPath: abs(args.logsRoot, eventsPathRel),
    eventsPathRel,
    phaseRoot: abs(args.logsRoot, phaseRootRel),
    phaseRootRel,
    metaPath: abs(args.logsRoot, metaPathRel),
    metaPathRel,
    ensureRunRoot() {
      mkdirSync(runRoot, { recursive: true })
    },
    ensurePhaseRoot() {
      mkdirSync(abs(args.logsRoot, phaseRootRel), { recursive: true })
    },
    phasePath(phase: string): RunArtifactPath {
      const safePhase = sanitizeArtifactSegment(phase)
      const pathRel = rel(phaseRootRel, `${safePhase}.json`)
      return {
        path: abs(args.logsRoot, pathRel),
        pathRel,
      }
    },
  }
}

export class FileRunArtifactWriter implements RunArtifactEventWriter {
  constructor(private readonly logsRoot: string) {}

  recordPhaseEvent(event: RunArtifactEvent): void {
    const artifacts = createRunArtifacts({ logsRoot: this.logsRoot, runId: event.runId })
    try {
      artifacts.ensureRunRoot()
      appendFileSync(artifacts.eventsPath, `${JSON.stringify(event)}\n`, 'utf-8')
      writeFileSync(
        artifacts.metaPath,
        `${JSON.stringify({
          runId: event.runId,
          lastPhase: event.phase,
          lastEventType: event.eventType,
          updatedAt: event.timestamp,
        }, null, 2)}\n`,
        'utf-8',
      )

      if (event.eventType !== 'phase_completed' || !event.data) return
      artifacts.ensurePhaseRoot()
      const phaseSnapshotPath = artifacts.phasePath(event.phase)
      writeFileSync(
        phaseSnapshotPath.path,
        `${JSON.stringify({
          runId: event.runId,
          phase: event.phase,
          eventType: event.eventType,
          timestamp: event.timestamp,
          artifacts: event.data,
        }, null, 2)}\n`,
        'utf-8',
      )
    } catch (err) {
      logger.debug(
        { runId: event.runId, phase: event.phase, eventType: event.eventType, err },
        'Failed to persist filesystem run artifact event',
      )
    }
  }
}

function sanitizeArtifactSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized.length > 0 ? sanitized : 'unknown'
}

function rel(...parts: string[]): string {
  return parts.join('/')
}

function abs(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}
