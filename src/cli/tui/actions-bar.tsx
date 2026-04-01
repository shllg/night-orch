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

function joinHintGroups(...groups: Array<string | null>): string {
  return groups.filter((group): group is string => Boolean(group && group.trim().length > 0)).join('  |  ')
}

function globalNavGroup(options: { includePoll: boolean; closeLabel?: '[q]quit' | '[q/esc]close' }): string {
  const closeHint = options.closeLabel ?? '[q]quit'
  const pollHint = options.includePoll ? ' [p]poll' : ''
  return `[1]issues [2]projects [3]stats ${closeHint}${pollHint}`
}

const EXTRA_TAB_NAV_GROUP = '[4]logs [h/l]tabs'

export function buildActionHints(props: ActionsBarProps): ActionHints {
  if (props.activeTab === 'runs') {
    if (props.runFocused) {
      return {
        line1: joinHintGroups(
          globalNavGroup({ includePoll: false, closeLabel: '[q/esc]close' }),
          '[j/k]scroll run',
          EXTRA_TAB_NAV_GROUP,
        ),
        line2: joinHintGroups('focused run detail', '[f]refresh'),
      }
    }

    const actionHints = props.busy
      ? 'actions locked while task is running'
      : '[r]etry [R]etry fresh [b]rebase [s]ync [c]leanup'

    return {
      line1: joinHintGroups(
        globalNavGroup({ includePoll: !props.busy }),
        '[j/k]select issue [o/enter]open',
        EXTRA_TAB_NAV_GROUP,
      ),
      line2: joinHintGroups(actionHints, '[f]refresh'),
    }
  }

  if (props.activeTab === 'stats') {
    const polling = props.autoRefresh ? 'polling live' : 'polling paused'
    return {
      line1: joinHintGroups(
        globalNavGroup({ includePoll: false }),
        '[f]refresh now [a]toggle auto-refresh',
        EXTRA_TAB_NAV_GROUP,
      ),
      line2: polling,
    }
  }

  if (props.activeTab === 'projects') {
    return {
      line1: joinHintGroups(
        globalNavGroup({ includePoll: false }),
        '[j/k]select project [f]refresh',
        EXTRA_TAB_NAV_GROUP,
      ),
      line2: 'view labels, lanes, tools, and environment config',
    }
  }

  return {
    line1: joinHintGroups(
      globalNavGroup({ includePoll: false }),
      '[j/k]scroll logs [f]refresh',
      EXTRA_TAB_NAV_GROUP,
    ),
    line2: '',
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
