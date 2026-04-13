import { describe, expect, it } from 'vitest'
import {
  moveLogSelection,
  moveProjectSelection,
  reconcileLogSelectionSnapshot,
  reconcileSelectedLogId,
  resolveActionCommand,
  resolveCleanupConfirmationTransition,
  resolveLogWindowSize,
  resolveSelectedLogIndex,
  resolveTabHotkey,
} from '../../../src/cli/tui/app.js'

describe('tui app input helpers', () => {
  it('maps tab hotkeys to tab ids', () => {
    expect(resolveTabHotkey('1')).toBe('runs')
    expect(resolveTabHotkey('2')).toBe('projects')
    expect(resolveTabHotkey('3')).toBe('stats')
    expect(resolveTabHotkey('4')).toBe('logs')
    expect(resolveTabHotkey('5')).toBe('settings')
    expect(resolveTabHotkey('6')).toBe('fileloop')
    expect(resolveTabHotkey('x')).toBeNull()
  })

  it('clamps project selection while moving down', () => {
    expect(moveProjectSelection(0, 1, 3)).toBe(1)
    expect(moveProjectSelection(1, 1, 3)).toBe(2)
    expect(moveProjectSelection(2, 1, 3)).toBe(2)
  })

  it('clamps project selection while moving up', () => {
    expect(moveProjectSelection(2, -1, 3)).toBe(1)
    expect(moveProjectSelection(1, -1, 3)).toBe(0)
    expect(moveProjectSelection(0, -1, 3)).toBe(0)
  })

  it('keeps index stable when no repos are configured', () => {
    expect(moveProjectSelection(0, 1, 0)).toBe(0)
    expect(moveProjectSelection(4, -1, 0)).toBe(0)
  })

  it('clamps log selection movement to available rows', () => {
    const logs = [
      { id: 10, createdAt: '2026-04-01T00:00:00.000Z', level: 'info', message: 'a' },
      { id: 11, createdAt: '2026-04-01T00:00:01.000Z', level: 'warn', message: 'b' },
      { id: 12, createdAt: '2026-04-01T00:00:02.000Z', level: 'error', message: 'c' },
    ]

    expect(moveLogSelection(logs, 10, 1)).toBe(11)
    expect(moveLogSelection(logs, 12, 1)).toBe(12)
    expect(moveLogSelection(logs, 10, -1)).toBe(10)
  })

  it('uses a minimum log window size for short terminals', () => {
    expect(resolveLogWindowSize(12)).toBe(4)
    expect(resolveLogWindowSize(40)).toBe(23)
  })

  it('keeps selected log id stable when capped buffer drops from head', () => {
    const before = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      createdAt: `2026-04-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      level: 'info' as const,
      message: `line-${index + 1}`,
    }))
    const after = before.slice(1)
    after.push({
      id: 501,
      createdAt: '2026-04-01T00:09:00.000Z',
      level: 'warn',
      message: 'line-501',
    })

    const selectedBefore = 250
    const selectedIndexBefore = resolveSelectedLogIndex(before, selectedBefore)
    const next = reconcileSelectedLogId(after, selectedBefore, selectedIndexBefore, before.length)

    expect(next).toBe(250)
  })

  it('falls back deterministically when selected id was evicted', () => {
    const before = [
      { id: 1, createdAt: '2026-04-01T00:00:00.000Z', level: 'info', message: 'one' },
      { id: 2, createdAt: '2026-04-01T00:00:01.000Z', level: 'info', message: 'two' },
      { id: 3, createdAt: '2026-04-01T00:00:02.000Z', level: 'info', message: 'three' },
    ]
    const after = [
      { id: 2, createdAt: '2026-04-01T00:00:01.000Z', level: 'info', message: 'two' },
      { id: 3, createdAt: '2026-04-01T00:00:02.000Z', level: 'info', message: 'three' },
      { id: 4, createdAt: '2026-04-01T00:00:03.000Z', level: 'warn', message: 'four' },
    ]

    const nextHead = reconcileSelectedLogId(after, 1, resolveSelectedLogIndex(before, 1), before.length)
    expect(nextHead).toBe(2)

    const nextTail = reconcileSelectedLogId(after, 3, resolveSelectedLogIndex(before, 3), before.length)
    expect(nextTail).toBe(4)
  })

  it('follows tail during capped-buffer rollover when previously at tail', () => {
    const before = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      createdAt: `2026-04-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      level: 'info' as const,
      message: `line-${index + 1}`,
    }))
    const after = before.slice(1)
    after.push({
      id: 501,
      createdAt: '2026-04-01T00:09:00.000Z',
      level: 'warn',
      message: 'line-501',
    })

    const snapshot = reconcileLogSelectionSnapshot(after, 500, 499, 500)

    expect(snapshot.selectedLogId).toBe(501)
    expect(snapshot.selectedLogIndex).toBe(499)
    expect(snapshot.logCount).toBe(500)
  })
})

describe('tui action key dispatch', () => {
  const baseArgs = {
    activeTab: 'runs' as const,
    runsViewMode: 'list' as const,
    projectsViewMode: 'list' as const,
    controlsEnabled: true,
    actionBusy: false,
    cleanupConfirmPending: false,
  }

  it('maps r to refresh globally', () => {
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'stats',
      input: 'r',
    })).toBe('refresh')
  })

  it('maps issue actions only on runs list mode', () => {
    expect(resolveActionCommand({
      ...baseArgs,
      input: 't',
    })).toBe('retry')
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'T',
    })).toBe('retry')
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'c',
    })).toBe('continue')
    expect(resolveActionCommand({
      ...baseArgs,
      input: '_',
    })).toBe('rebase')
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'X',
    })).toBe('deleteEntry')
    expect(resolveActionCommand({
      ...baseArgs,
      input: '$',
    })).toBe('costOverride')
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'stats',
      input: '$',
    })).toBe('none')
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'L',
    })).toBe('labelsInit')
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'stats',
      input: 'L',
    })).toBe('labelsInit')
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'stats',
      input: 't',
    })).toBe('none')
  })

  it('maps file-loop actions only on the file-loop tab', () => {
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'fileloop',
      input: 'f',
    })).toBe('fileLoopStart')
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'fileloop',
      input: 'x',
    })).toBe('fileLoopStop')
    expect(resolveActionCommand({
      ...baseArgs,
      activeTab: 'stats',
      input: 'f',
    })).toBe('none')
  })

  it('blocks p/s/D actions while focused run detail is open', () => {
    const focusedArgs = {
      ...baseArgs,
      runsViewMode: 'focus' as const,
    }
    expect(resolveActionCommand({
      ...focusedArgs,
      input: 'p',
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedArgs,
      input: 's',
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedArgs,
      input: 'D',
      cleanupConfirmPending: true,
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedArgs,
      input: 'L',
    })).toBe('none')
  })

  it('does not treat non-runs tabs as focused even when runsViewMode is focus', () => {
    const nonRunsFocusedArgs = {
      ...baseArgs,
      activeTab: 'stats' as const,
      runsViewMode: 'focus' as const,
    }

    expect(resolveActionCommand({
      ...nonRunsFocusedArgs,
      input: 'p',
    })).toBe('poll')
    expect(resolveActionCommand({
      ...nonRunsFocusedArgs,
      input: 'L',
    })).toBe('labelsInit')
    expect(resolveActionCommand({
      ...nonRunsFocusedArgs,
      input: 'D',
      cleanupConfirmPending: false,
    })).toBe('cleanupArm')
    expect(resolveActionCommand({
      ...nonRunsFocusedArgs,
      input: 't',
    })).toBe('none')
  })

  it('blocks p/s/D/L actions while focused project detail is open', () => {
    const focusedProjectArgs = {
      ...baseArgs,
      activeTab: 'projects' as const,
      projectsViewMode: 'focus' as const,
    }

    expect(resolveActionCommand({
      ...focusedProjectArgs,
      input: 'p',
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedProjectArgs,
      input: 's',
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedProjectArgs,
      input: 'D',
      cleanupConfirmPending: true,
    })).toBe('none')
    expect(resolveActionCommand({
      ...focusedProjectArgs,
      input: 'L',
    })).toBe('none')
  })

  it('requires double D press for cleanup command dispatch', () => {
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'D',
      cleanupConfirmPending: false,
    })).toBe('cleanupArm')
    expect(resolveActionCommand({
      ...baseArgs,
      input: 'D',
      cleanupConfirmPending: true,
    })).toBe('cleanupConfirm')
  })

  it('shows standalone message only for monitor-only controls when controls are disabled', () => {
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'p',
    })).toBe('standaloneMessage')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 's',
    })).toBe('standaloneMessage')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'D',
      cleanupConfirmPending: false,
    })).toBe('standaloneMessage')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'L',
    })).toBe('standaloneMessage')

    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 't',
    })).toBe('retry')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'T',
    })).toBe('retry')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'c',
    })).toBe('continue')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: '_',
    })).toBe('rebase')
    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      input: 'X',
    })).toBe('deleteEntry')

    expect(resolveActionCommand({
      ...baseArgs,
      controlsEnabled: false,
      activeTab: 'stats',
      input: 'X',
    })).toBe('none')
  })
})

describe('cleanup confirmation transitions', () => {
  it('supports arm and confirm flow on D presses', () => {
    expect(resolveCleanupConfirmationTransition(false, 'pressD')).toBe('arm')
    expect(resolveCleanupConfirmationTransition(true, 'pressD')).toBe('confirm')
  })

  it('cancels on non-D key and expires on timeout', () => {
    expect(resolveCleanupConfirmationTransition(true, 'pressOther')).toBe('cancel')
    expect(resolveCleanupConfirmationTransition(true, 'timeout')).toBe('expire')
  })
})
