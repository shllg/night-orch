// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBlock } from '../../web/src/components/ErrorBlock.js'

type ErrorBlockProps = React.ComponentProps<typeof ErrorBlock>

function renderErrorBlock(overrides: Partial<ErrorBlockProps> = {}): void {
  const props: ErrorBlockProps = {
    error: 'line 1\nline 2\nline 3\nline 4',
    collapsedLineCount: 2,
    ...overrides,
  }
  render(React.createElement(ErrorBlock, props))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ErrorBlock', () => {
  it('shows line numbers and collapsed output by default', () => {
    renderErrorBlock()

    expect(screen.getByText('line 1')).toBeDefined()
    expect(screen.getByText('line 2')).toBeDefined()
    expect(screen.queryByText('line 3')).toBeNull()
    expect(screen.getByText('Showing first 2 lines.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand' })).toBeDefined()
    expect(screen.getAllByTestId('error-line-number').map((node) => node.textContent)).toEqual(['01', '02'])
  })

  it('expands and collapses long errors', () => {
    renderErrorBlock()

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))

    expect(screen.getByText('line 3')).toBeDefined()
    expect(screen.getByText('line 4')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeDefined()
    expect(screen.getAllByTestId('error-line-number').map((node) => node.textContent)).toEqual(['01', '02', '03', '04'])

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByText('line 4')).toBeNull()
  })

  it('collapses oversized single-line errors by character count', () => {
    renderErrorBlock({
      error: 'x'.repeat(5_000),
      collapsedLineCount: 8,
      collapsedCharCount: 256,
    })

    expect(screen.getByText('Showing first 256 characters.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand' })).toBeDefined()
    expect(screen.getByText((content) => content.length === 256 && /^x+$/.test(content))).toBeDefined()
  })

  it('copies full error text and clears copied feedback after timeout', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderErrorBlock({
      error: 'critical failure\nstack line 1\nstack line 2',
      collapsedLineCount: 2,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('critical failure\nstack line 1\nstack line 2')
    expect(screen.getByText('Copied!')).toBeDefined()

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.queryByText('Copied!')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy error' })).toBeDefined()
  })

  it('falls back to execCommand when clipboard API writeText rejects', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockRejectedValue(new Error('clipboard denied'))
    const execCommand = vi.fn<(command: string) => boolean>().mockReturnValue(true)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    Object.defineProperty(globalThis.document, 'execCommand', {
      value: execCommand,
      configurable: true,
    })

    renderErrorBlock({
      error: 'fallback copy test',
      collapsedLineCount: 2,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('fallback copy test')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByText('Copied!')).toBeDefined()
  })
})
