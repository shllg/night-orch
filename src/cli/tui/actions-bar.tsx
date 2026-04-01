import React from 'react'
import { Box, Text } from 'ink'

interface ActionsBarProps {
  activeTab: 'runs' | 'stats' | 'logs'
  busy: boolean
  runFocused: boolean
  autoRefresh: boolean
}

interface ActionHints {
  line1: string
  line2: string
}

export function buildActionHints(props: ActionsBarProps): ActionHints {
  const tabHints = '[1]runs  [2]stats  [3]logs  [h/l]tabs'
  if (props.activeTab === 'runs') {
    const navHint = props.runFocused ? '[j/k]scroll  [esc/q]close' : '[j/k]select  [o/enter]open'
    const actionHints = props.busy
      ? 'actions locked while task is running'
      : '[r]etry  [b]rebase  [p]oll  [s]ync  [c]leanup'
    return {
      line1: `${tabHints}  ${navHint}`,
      line2: `${actionHints}  [f]refresh  [q]quit`,
    }
  }

  if (props.activeTab === 'stats') {
    const polling = props.autoRefresh ? 'polling live' : 'polling paused'
    return {
      line1: `${tabHints}  [f]refresh now  [a]toggle auto-refresh`,
      line2: `${polling}  [q]quit`,
    }
  }

  return {
    line1: `${tabHints}  [j/k]scroll logs  [f]refresh`,
    line2: '[q]quit',
  }
}

export function ActionsBar(props: ActionsBarProps): React.ReactElement {
  const hints = buildActionHints(props)

  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>{hints.line1}</Text>
      <Text dimColor>{hints.line2}</Text>
    </Box>
  )
}
