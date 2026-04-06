export type MergeBatchStatus = 'pending' | 'building' | 'testing' | 'passed' | 'failed' | 'bisecting'

export interface MergeBatchRecord {
  id: string
  repo: string
  baseBranch: string
  baseSha: string
  status: MergeBatchStatus
  stagingBranch: string | null
  stagingSha: string | null
  prNumbers: number[]
  /**
   * PRs actually merged into the staging branch. `null` before staging runs
   * or for pre-migration batches; callers that finalize/close PRs must
   * prefer this over `prNumbers` so ejected PRs are not closed as merged.
   */
  mergedPrNumbers: number[] | null
  approvedShas: string[]
  retryCount: number
  parentBatchId: string | null
  createdAt: string
  updatedAt: string
}
