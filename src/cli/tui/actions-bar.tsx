import React from 'react'
import { Box, Text } from 'ink'

interface ActionsBarProps {
  activeTab: 'runs' | 'stats'
  busy: boolean
}

export function ActionsBar({ activeTab, busy }: ActionsBarProps): React.ReactElement {
  const tabHints = '[1]runs  [2]stats  [h/l] switch tab'
  const listHints = activeTab === 'runs' ? '  [j/k] select run' : ''
  const actionHints = busy
    ? 'actions locked while task is running'
    : '[r]etry  [b]rebase  [s]ync  [c]leanup  [p]oll'

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="gray">{tabHints}{listHints}</Text>
      <Text color="gray">
        {actionHints}  [f]refresh  [q]uit
      </Text>
    </Box>
  )
}
