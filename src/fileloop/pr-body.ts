import type { FileLoopSession } from './types.js'
import type { VerifyResult } from '../workers/types.js'

export interface FileLoopPrBodyInput {
  session: FileLoopSession
  verifyResults: VerifyResult[]
  verifyPassed: boolean
  deferredNotes: Array<{ filePath: string; note: string }>
}

export function buildFileLoopPrTitle(session: FileLoopSession): string {
  return `File-loop session: ${session.filesTouched} files polished`
}

export function buildFileLoopPrBody(input: FileLoopPrBodyInput): string {
  const sections: string[] = []

  sections.push('## File-Loop Session')
  sections.push('')
  sections.push(`- Started: ${input.session.startedAt}`)
  sections.push(`- Ended: ${input.session.updatedAt}`)
  sections.push(`- Iterations: ${input.session.iterations}`)
  sections.push(`- Files touched: ${input.session.filesTouched}`)
  sections.push(`- Total cost (USD): ${input.session.totalCostUsd.toFixed(6)}`)
  sections.push(`- Stop reason: ${input.session.stoppedReason ?? 'manual'}`)
  sections.push('')

  sections.push('## Verification')
  sections.push('')
  if (input.verifyResults.length === 0) {
    sections.push('No finalize verification commands were configured.')
  } else {
    sections.push(`Overall: ${input.verifyPassed ? 'passed' : 'failed'}`)
    sections.push('')
    sections.push('| Command | Result |')
    sections.push('| --- | --- |')
    for (const result of input.verifyResults) {
      sections.push(`| \`${result.command}\` | ${result.passed ? 'pass' : 'fail'} |`)
    }
  }
  sections.push('')

  sections.push('## Deferred Refactors')
  sections.push('')
  if (input.deferredNotes.length === 0) {
    sections.push('No deferred refactors were recorded in this session.')
  } else {
    for (const note of input.deferredNotes) {
      sections.push(`- \`${note.filePath}\`: ${note.note}`)
    }
  }

  return sections.join('\n')
}
