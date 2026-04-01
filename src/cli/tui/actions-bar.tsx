import React from 'react'
import { Box, Text } from 'ink'
import type { TabId } from './types.js'

interface ActionsBarProps {
  activeTab: TabId
  busy: boolean
  runFocused: boolean
  autoRefresh: boolean
}

interface ActionHints {
  line1: string
  line2: string
}

export function buildActionHints(props: ActionsBarProps): ActionHints {
  const tabHints = '[1]runs  [2]projects  [3]stats  [4]logs  [h/l]tabs'
  if (props.activeTab === 'runs') {
    const navHint = props.runFocused ? '[j/k]scroll  [esc/q]close' : '[j/k]select  [o/enter]open'
    const actionHints = props.busy
      ? 'actions locked while task is running'
      : '[r]etry  [R]etry fresh  [b]rebase  [p]oll  [s]ync  [c]leanup'
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

  if (props.activeTab === 'projects') {
    return {
      line1: `${tabHints}  [j/k]select project  [f]refresh`,
      line2: 'view labels, lanes, tools, and environment config  [q]quit',
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
      <Text color="gray">{hints.line1}</Text>
      <Text color="gray">{hints.line2}</Text>
    </Box>
  )
}
