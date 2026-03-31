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
  approvedShas: string[]
  retryCount: number
  parentBatchId: string | null
  createdAt: string
  updatedAt: string
}
