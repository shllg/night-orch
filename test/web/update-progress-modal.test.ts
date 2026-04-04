import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UpdateProgressModal } from '../../web/src/components/UpdateProgressModal.js'
import { type UpdateStatus } from '../../web/src/types/dashboard.js'

describe('UpdateProgressModal', () => {
  it('renders live state details for standard update phases', () => {
    const text = renderModalText({ state: 'pulling' })

    expect(text).toContain('Applying self-update')
    expect(text).toContain('Current stage: Pulling')
    expect(text).toContain('Draining running services')
    expect(text).toContain('Pulling latest code')
    expect(text).toContain('Installing and building')
    expect(text).toContain('Dashboard controls are temporarily blocked.')
  })

  it('shows rollback messaging when update enters rollback phase', () => {
    const text = renderModalText({ state: 'rolling-back' })
    expect(text).toContain('Current stage: Rolling Back')
    expect(text).toContain('Rolling back to the previous known-good build.')
  })
})

function renderModalText(status: UpdateStatus): string {
  const html = renderToStaticMarkup(React.createElement(UpdateProgressModal, { status }))
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
