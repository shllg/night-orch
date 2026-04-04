import type { ReactElement } from 'react'
import type { IssueRowProps, IssueRowStatus } from './types.js'
import { buildIssueRowViewModel } from './view-model.js'

const STATUS_BADGE_CLASS: Record<IssueRowStatus, string> = {
  queued: 'badge-info',
  running: 'badge-warning',
  review: 'badge-accent',
  blocked: 'badge-error',
  done: 'badge-success',
}

export function IssueRowWeb(props: IssueRowProps): ReactElement {
  const row = buildIssueRowViewModel(props)

  return (
    <article className="rounded-box border border-base-300/60 bg-base-200/70 p-3 shadow-panel">
      <header className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs uppercase tracking-wide text-base-content/70">{row.issueRef}</span>
        <span className={`badge badge-sm ${STATUS_BADGE_CLASS[row.status]}`}>{row.statusLabel}</span>
      </header>
      <p className="mt-2 text-sm font-semibold text-base-content">{row.title}</p>
      <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/70">
        <span>{row.branchLabel}</span>
        <span>{row.updatedAtLabel}</span>
      </footer>
    </article>
  )
}
