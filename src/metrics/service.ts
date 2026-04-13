import type { Server } from 'node:http'
import { Registry } from 'prom-client'
import { createMetricsRegistry, type Metrics } from './collectors.js'
import { startMetricsServer } from './server.js'
import { logger } from '../utils/logger.js'

export interface MetricsServiceConfig {
  enabled: boolean
  host: string
  port: number
}

export interface MetricsService {
  start(): Promise<void>
  stop(): Promise<void>
  getRegistry(): Registry
  readonly ready: boolean
  readonly endpoint: { host: string; port: number } | null

  incRunsTotal(status: 'completed' | 'blocked' | 'error'): void
  incAgentInvocations(role: 'planner' | 'coder' | 'reviewer', adapter: 'claude' | 'codex'): void
  incLoopIterations(repo: string): void
  incVerifyRuns(result: 'pass' | 'fail'): void
  incPROperations(type: 'created' | 'updated'): void
  incNotifications(channel: string, result: 'sent' | 'failed'): void
  incCostTokenSource(source: 'reported_cli' | 'measured_api' | 'estimated_duration' | 'fallback_zero'): void
  setCheckpointQuarantineRows(count: number): void
  incCircuitBreakerTrip(repo: string): void

  observeRunDuration(durationSeconds: number): void
  observePhaseDuration(phase: string, durationSeconds: number): void
  observeAgentDuration(role: string, adapter: string, durationSeconds: number): void
  observeVerifyDuration(durationSeconds: number): void

  setActiveRuns(count: number): void
  setDailyCost(costUsd: number): void
  setEligibleIssues(repo: string, count: number): void
  addEstimatedCost(repo: string, agent: string, usd: number): void
}

class NoopMetricsService implements MetricsService {
  private emptyRegistry: Registry | undefined

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }
  get ready(): boolean { return false }
  get endpoint(): { host: string; port: number } | null { return null }

  getRegistry(): Registry {
    if (!this.emptyRegistry) {
      this.emptyRegistry = new Registry()
    }
    return this.emptyRegistry
  }

  incRunsTotal(): void { /* no-op */ }
  incAgentInvocations(): void { /* no-op */ }
  incLoopIterations(): void { /* no-op */ }
  incVerifyRuns(): void { /* no-op */ }
  incPROperations(): void { /* no-op */ }
  incNotifications(): void { /* no-op */ }
  incCostTokenSource(): void { /* no-op */ }
  setCheckpointQuarantineRows(): void { /* no-op */ }
  incCircuitBreakerTrip(): void { /* no-op */ }
  observeRunDuration(): void { /* no-op */ }
  observePhaseDuration(): void { /* no-op */ }
  observeAgentDuration(): void { /* no-op */ }
  observeVerifyDuration(): void { /* no-op */ }
  setActiveRuns(): void { /* no-op */ }
  setDailyCost(): void { /* no-op */ }
  setEligibleIssues(): void { /* no-op */ }
  addEstimatedCost(): void { /* no-op */ }
}

class LiveMetricsService implements MetricsService {
  private metrics: Metrics
  private server: Server | undefined
  private config: MetricsServiceConfig

  constructor(config: MetricsServiceConfig) {
    this.config = config
    this.metrics = createMetricsRegistry()
  }

  async start(): Promise<void> {
    const server = startMetricsServer(this.metrics, this.config.host, this.config.port)
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        cleanup()
        resolve()
      }

      const onError = (err: Error) => {
        cleanup()
        this.server = undefined
        reject(err)
      }

      const cleanup = () => {
        server.off('listening', onListening)
        server.off('error', onError)
      }

      server.once('listening', onListening)
      server.once('error', onError)
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  getRegistry(): Registry {
    return this.metrics.registry
  }

  get ready(): boolean {
    return this.server?.listening ?? false
  }

  get endpoint(): { host: string; port: number } | null {
    return { host: this.config.host, port: this.config.port }
  }

  incRunsTotal(status: 'completed' | 'blocked' | 'error'): void {
    try { this.metrics.runsTotal.inc({ status }) } catch { /* best-effort */ }
  }

  incAgentInvocations(role: 'planner' | 'coder' | 'reviewer', adapter: 'claude' | 'codex'): void {
    try { this.metrics.agentInvocations.inc({ role, adapter }) } catch { /* best-effort */ }
  }

  incLoopIterations(repo: string): void {
    try { this.metrics.loopIterations.inc({ repo }) } catch { /* best-effort */ }
  }

  incVerifyRuns(result: 'pass' | 'fail'): void {
    try { this.metrics.verifyRunsTotal.inc({ result }) } catch { /* best-effort */ }
  }

  incPROperations(type: 'created' | 'updated'): void {
    try { this.metrics.prOperations.inc({ type }) } catch { /* best-effort */ }
  }

  incNotifications(channel: string, result: 'sent' | 'failed'): void {
    try { this.metrics.notificationsTotal.inc({ channel, result }) } catch { /* best-effort */ }
  }

  incCostTokenSource(
    source: 'reported_cli' | 'measured_api' | 'estimated_duration' | 'fallback_zero',
  ): void {
    try { this.metrics.costTokenSourceTotal.inc({ source }) } catch { /* best-effort */ }
  }

  setCheckpointQuarantineRows(count: number): void {
    try { this.metrics.checkpointQuarantineRows.set(count) } catch { /* best-effort */ }
  }

  incCircuitBreakerTrip(repo: string): void {
    try { this.metrics.circuitBreakerTripsTotal.inc({ repo }) } catch { /* best-effort */ }
  }

  observeRunDuration(durationSeconds: number): void {
    try { this.metrics.runDuration.observe(durationSeconds) } catch { /* best-effort */ }
  }

  observePhaseDuration(phase: string, durationSeconds: number): void {
    try { this.metrics.phaseDuration.observe({ phase }, durationSeconds) } catch { /* best-effort */ }
  }

  observeAgentDuration(role: string, adapter: string, durationSeconds: number): void {
    try { this.metrics.agentDuration.observe({ role, adapter }, durationSeconds) } catch { /* best-effort */ }
  }

  observeVerifyDuration(durationSeconds: number): void {
    try { this.metrics.verifyDuration.observe(durationSeconds) } catch { /* best-effort */ }
  }

  setActiveRuns(count: number): void {
    try { this.metrics.activeRuns.set(count) } catch { /* best-effort */ }
  }

  setDailyCost(costUsd: number): void {
    try { this.metrics.dailyCostUsd.set(costUsd) } catch { /* best-effort */ }
  }

  setEligibleIssues(repo: string, count: number): void {
    try { this.metrics.eligibleIssues.set({ repo }, count) } catch { /* best-effort */ }
  }

  addEstimatedCost(repo: string, agent: string, usd: number): void {
    if (usd <= 0) return
    try { this.metrics.estimatedCost.inc({ repo, agent }, usd) } catch { /* best-effort */ }
  }
}

export function createMetricsService(config: MetricsServiceConfig): MetricsService {
  if (!config.enabled) {
    logger.info('Metrics disabled')
    return new NoopMetricsService()
  }
  return new LiveMetricsService(config)
}
