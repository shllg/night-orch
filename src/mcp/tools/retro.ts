import type { MCPDependencies } from '../server.js'
import { runRetro, listRecentSuggestions } from '../../ops/retro.js'
import { getSuggestion } from '../../state/retro.js'

export interface RetroRunArgs {
  sinceMs?: number
  classifier?: string
  dryRun?: boolean
}

export async function handleRetroRun(args: RetroRunArgs, deps: MCPDependencies): Promise<unknown> {
  const result = await runRetro(deps.db, {
    sinceMs: args.sinceMs,
    classifierFilter: args.classifier,
    dryRun: args.dryRun ?? false,
  })
  return {
    scanned: result.scanned,
    clusters: result.clusters,
    suggestions: result.suggestionsWritten.map((s) => ({
      id: s.id,
      classifier: s.classifier,
      targetTemplatePath: s.targetTemplatePath,
      generatedAt: s.generatedAt.toISOString(),
      sourceRunIds: s.sourceRunIds,
    })),
  }
}

export interface RetroListSuggestionsArgs {
  limit?: number
}

export async function handleRetroListSuggestions(
  args: RetroListSuggestionsArgs,
  deps: MCPDependencies,
): Promise<unknown> {
  const rows = listRecentSuggestions(deps.db, { limit: args.limit ?? 20 })
  return {
    count: rows.length,
    suggestions: rows.map((s) => ({
      id: s.id,
      classifier: s.classifier,
      targetTemplatePath: s.targetTemplatePath,
      generatedAt: s.generatedAt.toISOString(),
      appliedAt: s.appliedAt?.toISOString() ?? null,
      sourceRunIds: s.sourceRunIds,
    })),
  }
}

export interface RetroViewSuggestionArgs {
  id: number
}

export async function handleRetroViewSuggestion(
  args: RetroViewSuggestionArgs,
  deps: MCPDependencies,
): Promise<unknown> {
  const row = getSuggestion(deps.db, args.id)
  if (!row) throw new Error(`Suggestion not found: ${args.id}`)
  return {
    id: row.id,
    classifier: row.classifier,
    targetTemplatePath: row.targetTemplatePath,
    generatedAt: row.generatedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    sourceRunIds: row.sourceRunIds,
    suggestionMd: row.suggestionMd,
  }
}
