import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UpdateProgressOverlay } from '../../web/src/components/UpdateProgressModal.js'
import { type UpdateStatus } from '../../web/src/types/dashboard.js'

/**
 * Tests the overlay content directly (not the portal wrapper) because
 * renderToStaticMarkup does not support createPortal.
 */
describe('UpdateProgressModal', () => {
  it('renders git-style step labels by default', () => {
    const text = renderModalText({ state: 'pulling' })

    expect(text).toContain('Applying self-update')
    expect(text).toContain('Draining running services')
    expect(text).toContain('Pulling latest code')
    expect(text).toContain('Installing and building')
    expect(text).toContain('Restarting supervisor')
    expect(text).toContain('Running health checks')
    expect(text).toContain('Dashboard controls are temporarily blocked.')
  })

  it('renders npm-style step labels when installMethod is npm', () => {
    const text = renderModalText({ state: 'pulling', installMethod: 'npm' })

    expect(text).toContain('Checking npm registry')
    expect(text).toContain('Installing package globally')
    // Should NOT contain git-specific labels
    expect(text).not.toContain('Pulling latest code')
    expect(text).not.toContain('Installing and building')
  })

  it('shows rollback messaging when update enters rollback phase', () => {
    const text = renderModalText({ state: 'rolling-back' })
    expect(text).toContain('Rolling back to the previous known-good build.')
  })

  it('shows server-unreachable indicator when serverUnreachable is true', () => {
    const text = renderModalText({ state: 'draining' }, true)
    expect(text).toContain('reconnecting')
  })

  it('displays version info when previousCommit and targetCommit are provided', () => {
    const text = renderModalText({
      state: 'pulling',
      previousCommit: 'abc1234567890',
      targetCommit: 'def9876543210',
    })
    expect(text).toContain('abc12345')
    expect(text).toContain('def98765')
  })

  it('displays elapsed time when provided', () => {
    const text = renderModalText({ state: 'pulling' }, false, 65)
    expect(text).toContain('1m 5s')
  })
})

function renderModalText(
  status: UpdateStatus,
  serverUnreachable = false,
  elapsedSeconds?: number,
): string {
  const html = renderToStaticMarkup(
    React.createElement(UpdateProgressOverlay, { status, serverUnreachable, elapsedSeconds }),
  )
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
