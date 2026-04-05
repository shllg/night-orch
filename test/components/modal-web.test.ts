import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  handleModalEscapeKey,
  ModalWeb,
  requestModalClose,
  resolveModalDismissState,
} from '../../src/components/modal/modal.web.js'

describe('ModalWeb', () => {
  it('returns empty output when closed', () => {
    const html = renderToStaticMarkup(React.createElement(ModalWeb, {
      open: false,
      title: 'Hidden modal',
    }))

    expect(html).toBe('')
  })

  it('renders close button and clickable backdrop by default', () => {
    const html = renderToStaticMarkup(React.createElement(ModalWeb, {
      open: true,
      title: 'Dismissible modal',
      onClose: () => undefined,
    }))

    expect(html).toContain('btn-circle')
    expect(html).toContain('<button type="button" class="modal-backdrop"')
  })

  it('renders non-clickable backdrop when closeOnBackdropClick is false', () => {
    const html = renderToStaticMarkup(React.createElement(ModalWeb, {
      open: true,
      title: 'No backdrop dismiss',
      onClose: () => undefined,
      closeOnBackdropClick: false,
    }))

    expect(html).toContain('btn-circle')
    expect(html).toContain('<div class="modal-backdrop cursor-default" aria-hidden="true"></div>')
    expect(html).not.toContain('<button type="button" class="modal-backdrop"')
  })

  it('suppresses close controls in blocking mode', () => {
    const html = renderToStaticMarkup(React.createElement(ModalWeb, {
      open: true,
      title: 'Blocking modal',
      onClose: () => undefined,
      blocking: true,
    }))

    expect(html).not.toContain('btn-circle')
    expect(html).toContain('<div class="modal-backdrop cursor-default" aria-hidden="true"></div>')
  })

  it('uses explicit ariaLabel even when title is present', () => {
    const html = renderToStaticMarkup(React.createElement(ModalWeb, {
      open: true,
      title: 'Visible title',
      ariaLabel: 'Self update in progress',
    }))

    expect(html).toContain('aria-label="Self update in progress"')
    expect(html).not.toContain('aria-labelledby=')
  })
})

describe('modal dismissal helpers', () => {
  it('computes dismiss state for default, opt-out, and blocking modes', () => {
    const onClose = () => undefined

    expect(resolveModalDismissState({ onClose })).toEqual({
      canRequestClose: true,
      shouldCloseOnBackdropClick: true,
    })
    expect(resolveModalDismissState({ onClose, closeOnBackdropClick: false })).toEqual({
      canRequestClose: true,
      shouldCloseOnBackdropClick: false,
    })
    expect(resolveModalDismissState({ onClose, blocking: true })).toEqual({
      canRequestClose: false,
      shouldCloseOnBackdropClick: false,
    })
  })

  it('only invokes close callback when closure is permitted', () => {
    const onClose = vi.fn()

    expect(requestModalClose(false, onClose)).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(requestModalClose(true, onClose)).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('handles Escape key only when closure is permitted', () => {
    const onClose = vi.fn()
    const preventDefault = vi.fn()

    expect(handleModalEscapeKey({ key: 'Enter', preventDefault }, true, onClose)).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()

    expect(handleModalEscapeKey({ key: 'Escape', preventDefault }, false, onClose)).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()

    expect(handleModalEscapeKey({ key: 'Escape', preventDefault }, true, onClose)).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
