import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { IssueRowProps, IssueRowStatus } from './types.js'
import { buildIssueRowViewModel } from './view-model.js'

type StatusColor = 'blue' | 'yellow' | 'magenta' | 'red' | 'green'

const STATUS_COLOR: Record<IssueRowStatus, StatusColor> = {
  queued: 'blue',
  running: 'yellow',
  review: 'magenta',
  blocked: 'red',
  done: 'green',
}

export function IssueRowTui(props: IssueRowProps): ReactElement {
  const row = buildIssueRowViewModel(props)

  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="gray">{row.issueRef}</Text>
        <Text color={STATUS_COLOR[row.status]}>{row.statusLabel}</Text>
      </Box>
      <Text>{row.title}</Text>
      <Text color="gray">
        {row.branchLabel} | {row.updatedAtLabel}
      </Text>
    </Box>
  )
}
