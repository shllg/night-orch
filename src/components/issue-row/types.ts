export type IssueRowStatus = 'queued' | 'running' | 'review_ready' | 'blocked' | 'completed' | 'error'

export interface IssueRowProps {
  repo: string
  issueNumber: number
  title: string
  status: IssueRowStatus
  branch?: string | null
  updatedAtIso?: string | null
}

export interface IssueRowViewModel {
  issueRef: string
  title: string
  status: IssueRowStatus
  statusLabel: string
  branchLabel: string
  updatedAtLabel: string
}
