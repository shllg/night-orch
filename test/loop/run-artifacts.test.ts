import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRunArtifacts, FileRunArtifactWriter } from '../../src/loop/run-artifacts.js'

describe('run artifacts', () => {
  it('builds deterministic per-run artifact paths under logsRoot', () => {
    const logsRoot = '/tmp/night-orch-logs'
    const artifacts = createRunArtifacts({ logsRoot, runId: 'run-123' })

    expect(artifacts.runRoot).toBe(join(logsRoot, 'runs', 'run-123'))
    expect(artifacts.runRootRel).toBe('runs/run-123')
    expect(artifacts.eventsPathRel).toBe('runs/run-123/events.jsonl')
    expect(artifacts.phasePath('verify').pathRel).toBe('runs/run-123/phases/verify.json')
  })

  it('does not create directories until events are recorded', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-run-artifacts-test-'))
    const logsRoot = join(tmpDir, 'logs')
    try {
      const artifacts = createRunArtifacts({ logsRoot, runId: 'run-123' })
      expect(existsSync(artifacts.runRoot)).toBe(false)
      expect(existsSync(artifacts.eventsPath)).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes event stream and per-phase artifact snapshots', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-run-artifacts-test-'))
    const logsRoot = join(tmpDir, 'logs')
    const writer = new FileRunArtifactWriter(logsRoot)
    const artifacts = createRunArtifacts({ logsRoot, runId: 'run-abc' })
    try {
      writer.recordPhaseEvent({
        runId: 'run-abc',
        phase: 'plan',
        eventType: 'phase_started',
        data: null,
        timestamp: '2026-05-26T10:00:00.000Z',
      })
      writer.recordPhaseEvent({
        runId: 'run-abc',
        phase: 'plan',
        eventType: 'phase_completed',
        data: { plan: { objective: 'Fix login' } },
        timestamp: '2026-05-26T10:00:01.000Z',
      })

      const eventLines = readFileSync(artifacts.eventsPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(eventLines).toHaveLength(2)
      expect(eventLines[0]?.['eventType']).toBe('phase_started')
      expect(eventLines[1]?.['eventType']).toBe('phase_completed')

      const phaseSnapshot = JSON.parse(readFileSync(artifacts.phasePath('plan').path, 'utf-8')) as Record<string, unknown>
      expect(phaseSnapshot['runId']).toBe('run-abc')
      expect(phaseSnapshot['phase']).toBe('plan')
      expect(phaseSnapshot['eventType']).toBe('phase_completed')
      expect(phaseSnapshot['artifacts']).toEqual({ plan: { objective: 'Fix login' } })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sanitizes phase filenames so artifact writes are filesystem-safe', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-run-artifacts-test-'))
    const logsRoot = join(tmpDir, 'logs')
    const writer = new FileRunArtifactWriter(logsRoot)
    const artifacts = createRunArtifacts({ logsRoot, runId: 'run-safe' })
    try {
      writer.recordPhaseEvent({
        runId: 'run-safe',
        phase: 'review/qa check',
        eventType: 'phase_completed',
        data: { ok: true },
        timestamp: '2026-05-26T10:00:01.000Z',
      })

      const safePhasePath = artifacts.phasePath('review_qa_check').path
      expect(existsSync(safePhasePath)).toBe(true)
      const snapshot = JSON.parse(readFileSync(safePhasePath, 'utf-8')) as Record<string, unknown>
      expect(snapshot['phase']).toBe('review/qa check')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
