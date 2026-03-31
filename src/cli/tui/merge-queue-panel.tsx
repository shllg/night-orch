import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'

interface MergeQueuePanelProps {
  db: Database.Database
  tick: number
}

interface MergeBatchRow {
  id: string
  repo: string
  status: string
  pr_numbers: string
  staging_branch: string | null
}

export function MergeQueuePanel({ db, tick: _tick }: MergeQueuePanelProps): React.ReactElement {
  const batches = db
    .prepare("SELECT id, repo, status, pr_numbers, staging_branch FROM merge_batches WHERE status NOT IN ('passed', 'failed') ORDER BY created_at DESC LIMIT 5")
    .all() as MergeBatchRow[]

  if (batches.length === 0) return <></>

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Merge Queue</Text>
      {batches.map(batch => {
        const prs = JSON.parse(batch.pr_numbers) as number[]
        return (
          <Text key={batch.id}>
            {'  '}
            <Text color="cyan">{batch.status}</Text>
            {' PRs: '}
            <Text>{prs.join(', ')}</Text>
            {'  '}
            <Text color="gray">{batch.repo}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
