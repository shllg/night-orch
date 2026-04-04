import type { IssueRowProps, IssueRowStatus, IssueRowViewModel } from './types.js'

const STATUS_LABELS: Record<IssueRowStatus, string> = {
  queued: 'queued',
  running: 'running',
  review: 'in review',
  blocked: 'blocked',
  done: 'done',
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
