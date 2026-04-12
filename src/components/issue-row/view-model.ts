import type { IssueRowProps, IssueRowStatus, IssueRowViewModel } from './types.js'

export const STATUS_LABELS: Record<IssueRowStatus, string> = {
  queued: 'queued',
  running: 'running',
  review_ready: 'in review',
  blocked: 'blocked',
  completed: 'done',
  error: 'error',
}

export function normalizeRunStatus(status: string): IssueRowStatus {
  switch (status.trim().toLowerCase()) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'review_ready':
      return 'review_ready'
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    default:
      return 'error'
  }
}

export function buildIssueRowViewModel(props: IssueRowProps): IssueRowViewModel {
  const issueRef = `${props.repo}#${String(props.issueNumber)}`
  const branchLabel = props.branch ? `branch ${props.branch}` : 'branch --'
  const updatedAtLabel = formatUpdatedAt(props.updatedAtIso)

  return {
    issueRef,
    title: props.title,
    status: props.status,
    statusLabel: STATUS_LABELS[props.status],
    branchLabel,
    updatedAtLabel,
  }
}

function formatUpdatedAt(updatedAtIso?: string | null): string {
  if (!updatedAtIso) {
    return 'updated --'
  }

  const date = new Date(updatedAtIso)
  if (Number.isNaN(date.getTime())) {
    return 'updated --'
  }

  return `updated ${date.toISOString().slice(0, 16)}Z`
}
