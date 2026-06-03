import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import {
  listClassifiersSince,
  listSuggestions,
  recordSuggestion,
  type RetroClassifier,
  type RetroSuggestion,
} from '../state/retro.js'
import { listPromptCompilationsByPhase } from '../state/prompt-compilations.js'

export interface RetroRunOptions {
  /** Earliest classifier to include, epoch ms. Defaults to 7d ago. */
  sinceMs?: number
  /** Only emit suggestions for this classifier (otherwise: all clusters). */
  classifierFilter?: string
  /**
   * Dry-run: cluster + log, but do not write `retro_suggestions` rows. The
   * CLI uses this so an operator can inspect the clustering before
   * committing to a meta-agent invocation. The default-write path is
   * intentional because retro is rare-and-explicit.
   */
  dryRun?: boolean
}

export interface RetroCluster {
  classifier: string
  count: number
  sourceRunIds: string[]
  recentPhase: string
}

export interface RetroRunResult {
  scanned: number
  clusters: RetroCluster[]
  suggestionsWritten: RetroSuggestion[]
}

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Aggregate recent failure classifiers into clusters keyed by classifier,
 * then emit one `retro_suggestions` row per cluster pointing at the most
 * common prompt template observed for that phase.
 *
 * v1 of the engine does NOT invoke the meta-agent worker — it produces a
 * placeholder suggestion documenting the cluster so operators can decide
 * whether to manually rewrite the template or feed the cluster into an
 * external LLM call. The slot for the meta-agent worker is reserved in
 * ADR 0002 and will be wired in a follow-up.
 */
export async function runRetro(
  db: Database.Database,
  options: RetroRunOptions = {},
): Promise<RetroRunResult> {
  const sinceMs = options.sinceMs ?? Date.now() - DEFAULT_LOOKBACK_MS
  const classifiers = listClassifiersSince(db, sinceMs).filter(
    (c) => !options.classifierFilter || c.classifier === options.classifierFilter,
  )

  const clusters = clusterByClassifier(classifiers)
  logger.info(
    { scanned: classifiers.length, clusterCount: clusters.length, sinceMs },
    'Retro: aggregated classifier clusters',
  )

  const written: RetroSuggestion[] = []
  if (!options.dryRun) {
    for (const cluster of clusters) {
      const template = resolveDominantTemplate(db, cluster, sinceMs)
      const suggestion = recordSuggestion(db, {
        classifier: cluster.classifier,
        targetTemplatePath: template,
        suggestionMd: renderPlaceholderSuggestion(cluster, template),
        sourceRunIds: cluster.sourceRunIds,
      })
      written.push(suggestion)
    }
  }

  return { scanned: classifiers.length, clusters, suggestionsWritten: written }
}

export function listRecentSuggestions(
  db: Database.Database,
  options: { limit?: number } = {},
): RetroSuggestion[] {
  return listSuggestions(db, { limit: options.limit ?? 20 })
}

function clusterByClassifier(rows: RetroClassifier[]): RetroCluster[] {
  const map = new Map<string, RetroCluster>()
  for (const row of rows) {
    const existing = map.get(row.classifier)
    if (existing) {
      existing.count += 1
      if (!existing.sourceRunIds.includes(row.runId)) {
        existing.sourceRunIds.push(row.runId)
      }
      existing.recentPhase = row.phase
    } else {
      map.set(row.classifier, {
        classifier: row.classifier,
        count: 1,
        sourceRunIds: [row.runId],
        recentPhase: row.phase,
      })
    }
  }
  // Most common first
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function resolveDominantTemplate(
  db: Database.Database,
  cluster: RetroCluster,
  sinceMs: number,
): string {
  const compilations = listPromptCompilationsByPhase(db, cluster.recentPhase, sinceMs)
  if (compilations.length === 0) return '(unknown template)'
  const counts = new Map<string, number>()
  for (const c of compilations) {
    const key = c.templatePath ?? '(default template)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: string = '(unknown template)'
  let bestCount = -1
  for (const [path, n] of counts) {
    if (n > bestCount) {
      best = path
      bestCount = n
    }
  }
  return best
}

function renderPlaceholderSuggestion(cluster: RetroCluster, template: string): string {
  return [
    `# Retro suggestion: ${cluster.classifier}`,
    '',
    `Observed in **${cluster.count} runs** across phase \`${cluster.recentPhase}\`.`,
    '',
    `Dominant template: \`${template}\``,
    '',
    `Source runs (${cluster.sourceRunIds.length}):`,
    ...cluster.sourceRunIds.slice(0, 10).map((id) => `- ${id}`),
    '',
    '## Suggested action',
    '',
    `Review the template above against the cluster of failures. The meta-`,
    `agent worker is not yet wired (see ADR 0002) — for now an operator`,
    `should inspect the handoffs of the source runs and decide whether to`,
    `update the template manually.`,
  ].join('\n')
}
