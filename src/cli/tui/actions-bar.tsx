import React from 'react'
import { Box, Text } from 'ink'
import type { TabId } from './types.js'

interface ActionsBarProps {
  activeTab: TabId
  busy: boolean
  runFocused: boolean
  autoRefresh: boolean
  controlsEnabled?: boolean
}

interface ActionHintSection {
  name: 'navigation' | 'global' | 'issue'
  hints: string
}

interface ActionHints {
  sections: ActionHintSection[]
}

function joinHintGroups(...groups: Array<string | null>): string {
  return groups.filter((group): group is string => Boolean(group && group.trim().length > 0)).join('  |  ')
}

function navigationHints(activeTab: TabId, runFocused: boolean): string {
  if (activeTab === 'runs' && runFocused) {
    return '[1-4]tabs [h/l]tabs [j/k]scroll run'
  }
  if (activeTab === 'runs') {
    return '[1-4]tabs [h/l]tabs [j/k]select issue [o/enter]open'
  }
  if (activeTab === 'projects') {
    return '[1-4]tabs [h/l]tabs [j/k]select project'
  }
  if (activeTab === 'logs') {
    return '[1-4]tabs [h/l]tabs [j/k]select log [J/K]scroll raw'
  }
  return '[1-4]tabs [h/l]tabs'
}

function globalHints(options: {
  activeTab: TabId
  busy: boolean
  runFocused: boolean
  controlsEnabled: boolean
}): string {
  const { activeTab, busy, runFocused, controlsEnabled } = options
  if (activeTab === 'runs' && runFocused) {
    return '[q/esc]close [r]refresh'
  }

  const autoRefreshHint = activeTab === 'stats' ? ' [a]toggle auto-refresh' : ''
  const actionHints = controlsEnabled && !busy ? ' [p]poll [s]sync [D]cleanup(confirm)' : ''
  return `[q]quit [r]refresh${autoRefreshHint}${actionHints}`
}

function issueHints(options: {
  activeTab: TabId
  busy: boolean
  runFocused: boolean
}): string {
  const { activeTab, busy, runFocused } = options
  if (activeTab !== 'runs') {
    return 'n/a (issue actions on runs tab)'
  }
  if (runFocused) {
    return 'focused run detail'
  }
  if (busy) {
    return 'actions locked while task is running'
  }
  return '[t]retry [T]retry fresh [_]rebase [X]delete entry'
}

export function buildActionHints(props: ActionsBarProps): ActionHints {
  const controlsEnabled = props.controlsEnabled ?? true

  return {
    sections: [
      {
        name: 'navigation',
        hints: navigationHints(props.activeTab, props.runFocused),
      },
      {
        name: 'global',
        hints: globalHints({
          activeTab: props.activeTab,
          busy: props.busy,
          runFocused: props.runFocused,
          controlsEnabled,
        }),
      },
      {
        name: 'issue',
        hints: issueHints({
          activeTab: props.activeTab,
          busy: props.busy,
          runFocused: props.runFocused,
        }),
      },
    ],
  }
}

export function ActionsBar(props: ActionsBarProps): React.ReactElement {
  const hints = buildActionHints(props)

  return (
    <Box marginTop={1} flexDirection="column">
      {hints.sections.map((section) => (
        <Text key={section.name} color="gray">
          {section.name}:{' '}
          {joinHintGroups(section.hints, section.name === 'global' && props.activeTab === 'stats'
            ? (props.autoRefresh ? 'polling live' : 'polling paused')
            : null)}
        </Text>
      ))}
    </Box>
  )
}
