import React from 'react'
import { Box, Text } from 'ink'
import type { UpdateStrategy } from '../../git/worktree.js'
import type { TabId } from './types.js'

interface ActionsBarProps {
  activeTab: TabId
  busy: boolean
  runsFocused: boolean
  projectsFocused: boolean
  autoRefresh: boolean
  controlsEnabled?: boolean
  manualStrategy: UpdateStrategy | null
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

function navigationHints(activeTab: TabId, runsFocused: boolean, projectsFocused: boolean): string {
  if (activeTab === 'runs' && runsFocused) {
    return '[1-7]tabs [h/l]tabs [j/k]scroll run'
  }
  if (activeTab === 'projects' && projectsFocused) {
    return '[1-7]tabs [h/l]tabs'
  }
  if (activeTab === 'runs') {
    return '[1-7]tabs [h/l]tabs [j/k]select issue [o/enter]open'
  }
  if (activeTab === 'projects') {
    return '[1-7]tabs [h/l]tabs [j/k]select project [o/enter]open'
  }
  if (activeTab === 'fileloop') {
    return '[1-7]tabs [h/l]tabs [j/k]select repo'
  }
  if (activeTab === 'logs') {
    return '[1-7]tabs [h/l]tabs [j/k]select log [J/K]scroll raw'
  }
  if (activeTab === 'settings') {
    return '[1-7]tabs [h/l]tabs [j/k]select setting'
  }
  if (activeTab === 'timeline') {
    return '[1-7]tabs [h/l]tabs (select an issue in tab 1 to populate)'
  }
  return '[1-7]tabs [h/l]tabs'
}

function globalHints(options: {
  activeTab: TabId
  busy: boolean
  runsFocused: boolean
  projectsFocused: boolean
  controlsEnabled: boolean
}): string {
  const { activeTab, busy, runsFocused, projectsFocused, controlsEnabled } = options
  if ((activeTab === 'runs' && runsFocused) || (activeTab === 'projects' && projectsFocused)) {
    return '[q/esc]close [r]refresh'
  }

  const autoRefreshHint = activeTab === 'stats' ? ' [a]toggle auto-refresh' : ''
  const actionHints = controlsEnabled && !busy ? ' [p]poll [s]sync [R]reload-config [L]labels-init [D]cleanup(confirm) [%]daily-cap-override' : ''
  return `[q]quit [r]refresh${autoRefreshHint}${actionHints}`
}

function issueHints(options: {
  activeTab: TabId
  busy: boolean
  runsFocused: boolean
  projectsFocused: boolean
  manualStrategy: UpdateStrategy | null
}): string {
  const { activeTab, busy, runsFocused, projectsFocused, manualStrategy } = options
  if (activeTab === 'settings') {
    return '[+/-]adjust number [space]toggle bool [u]unset override'
  }
  if (activeTab === 'projects' && projectsFocused) {
    return 'focused project detail'
  }
  if (activeTab === 'fileloop') {
    return '[f]start [x]stop'
  }
  if (activeTab !== 'runs') {
    return 'n/a (issue actions on runs tab)'
  }
  if (runsFocused) {
    return 'focused run detail'
  }
  if (busy) {
    return 'actions locked while task is running'
  }
  const strategyLabel = manualStrategy ?? 'default'
  return `[t/T]retry [c]continue [_]rebase [m]strategy:${strategyLabel} [X]delete entry [$]cost-override`
}

export function buildActionHints(props: ActionsBarProps): ActionHints {
  const controlsEnabled = props.controlsEnabled ?? true

  return {
    sections: [
      {
        name: 'navigation',
        hints: navigationHints(props.activeTab, props.runsFocused, props.projectsFocused),
      },
      {
        name: 'global',
        hints: globalHints({
          activeTab: props.activeTab,
          busy: props.busy,
          runsFocused: props.runsFocused,
          projectsFocused: props.projectsFocused,
          controlsEnabled,
        }),
      },
      {
        name: 'issue',
        hints: issueHints({
          activeTab: props.activeTab,
          busy: props.busy,
          runsFocused: props.runsFocused,
          projectsFocused: props.projectsFocused,
          manualStrategy: props.manualStrategy,
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
