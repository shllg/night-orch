import { describe, expect, it } from 'vitest'
import {
  moveLogSelection,
  moveProjectSelection,
  reconcileLogSelectionSnapshot,
  reconcileSelectedLogId,
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
