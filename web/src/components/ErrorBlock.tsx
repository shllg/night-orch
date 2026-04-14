import { type MouseEvent, type ReactElement, useEffect, useMemo, useState } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

const COPY_FEEDBACK_MS = 2000
const DEFAULT_COLLAPSED_LINE_COUNT = 8
const DEFAULT_COLLAPSED_CHAR_COUNT = 4000

type CopyStatus = 'idle' | 'copied' | 'failed'
type TruncationReason = 'line' | 'char' | null

interface ErrorBlockProps {
  error: string
  className?: string
  title?: string
  collapsedLineCount?: number
  collapsedCharCount?: number
  defaultExpanded?: boolean
}

export function ErrorBlock({
  error,
  className,
  title = 'Error output',
  collapsedLineCount = DEFAULT_COLLAPSED_LINE_COUNT,
  collapsedCharCount = DEFAULT_COLLAPSED_CHAR_COUNT,
  defaultExpanded = false,
}: ErrorBlockProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  const safeCollapsedLineCount = Math.max(1, Math.floor(collapsedLineCount))
  const safeCollapsedCharCount = Math.max(256, Math.floor(collapsedCharCount))
  const collapsedPreview = useMemo(
    () => buildCollapsedPreview(error, safeCollapsedLineCount, safeCollapsedCharCount),
    [error, safeCollapsedCharCount, safeCollapsedLineCount],
  )
  const canExpand = collapsedPreview.truncated
  const expandedLines = useMemo(
    () => (expanded && canExpand ? splitErrorLines(error) : null),
    [canExpand, error, expanded],
  )
  const visibleLines = expanded && expandedLines !== null
    ? expandedLines
    : collapsedPreview.lines
  const lineNumberWidth = Math.max(2, String(Math.max(visibleLines.length, 1)).length)

  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded, error])

  useEffect(() => {
    if (copyStatus === 'idle') return undefined
    const timer = globalThis.setTimeout(() => {
      setCopyStatus('idle')
    }, COPY_FEEDBACK_MS)
    return () => {
      globalThis.clearTimeout(timer)
    }
  }, [copyStatus])

  const onCopyClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    void copyErrorText(error)
      .then(() => setCopyStatus('copied'))
      .catch(() => setCopyStatus('failed'))
  }

  const onExpandClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setExpanded((current) => !current)
  }

  const copyStatusLabel = copyStatus === 'copied'
    ? 'Copied!'
    : copyStatus === 'failed'
      ? 'Copy failed'
      : null
  const copyButtonLabel = copyStatus === 'copied'
    ? 'Copied!'
    : copyStatus === 'failed'
      ? 'Copy failed'
      : 'Copy error'
  const previewMessage = canExpand && !expanded
    ? collapsedPreview.reason === 'line'
      ? `Showing first ${visibleLines.length} lines.`
      : `Showing first ${safeCollapsedCharCount.toLocaleString()} characters.`
    : null
  const composedClassName = className
    ? `min-w-0 rounded-md border border-error/35 bg-error/10 p-2 text-error ${className}`
    : 'min-w-0 rounded-md border border-error/35 bg-error/10 p-2 text-error'

  return (
    <div
      className={composedClassName}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-error/75">
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {copyStatusLabel && (
            <span role="status" className="text-[10px] font-medium text-error/80">
              {copyStatusLabel}
            </span>
          )}
          {canExpand && (
            <ButtonWeb
              type="button"
              tone="ghost"
              size="xs"
              className="border border-error/35 bg-base-100/55 text-[11px] text-error/85 hover:border-error/50 hover:bg-base-100/75"
              onClick={onExpandClick}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </ButtonWeb>
          )}
          <ButtonWeb
            type="button"
            tone="ghost"
            size="xs"
            shape="circle"
            className="border border-error/35 bg-base-100/55 text-error/85 hover:border-error/50 hover:bg-base-100/75"
            title={copyButtonLabel}
            ariaLabel={copyButtonLabel}
            onClick={onCopyClick}
          >
            <ClipboardIcon />
          </ButtonWeb>
        </div>
      </div>

      <div className="min-w-0 overflow-x-auto rounded border border-error/25 bg-base-100/45 px-2 py-1.5 font-mono text-[11px] leading-5 text-error/90">
        {visibleLines.map((line, index) => (
          <div key={index} className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3">
            <span
              data-testid="error-line-number"
              className="select-none pr-0.5 text-right tabular-nums text-error/60"
              style={{ minWidth: `${lineNumberWidth}ch` }}
            >
              {String(index + 1).padStart(lineNumberWidth, '0')}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {line.length > 0 ? line : ' '}
            </span>
          </div>
        ))}
      </div>

      {previewMessage && (
        <p className="mt-1 text-[10px] text-error/75">
          {previewMessage}
        </p>
      )}
    </div>
  )
}

async function copyErrorText(value: string): Promise<void> {
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall through to the legacy path if Clipboard API is blocked/rejected.
    }
  }

  if (!globalThis.document?.body || typeof globalThis.document.execCommand !== 'function') {
    throw new Error('Clipboard API unavailable')
  }

  const textArea = globalThis.document.createElement('textarea')
  const previouslyFocusedElement = globalThis.document.activeElement instanceof HTMLElement
    ? globalThis.document.activeElement
    : null
  textArea.value = value
  textArea.setAttribute('readonly', 'true')
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  textArea.style.pointerEvents = 'none'
  globalThis.document.body.appendChild(textArea)
  let copied = false
  try {
    textArea.focus()
    textArea.select()
    copied = globalThis.document.execCommand('copy')
  } finally {
    globalThis.document.body.removeChild(textArea)
    if (previouslyFocusedElement && typeof previouslyFocusedElement.focus === 'function') {
      try {
        previouslyFocusedElement.focus()
      } catch {
        // Ignore focus restore failures for detached/disabled elements.
      }
    }
  }

  if (!copied) {
    throw new Error('Copy failed')
  }
}

function splitErrorLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, '\n')
  return normalized.split('\n')
}

function buildCollapsedPreview(
  value: string,
  maxLines: number,
  maxChars: number,
): { lines: string[]; truncated: boolean; reason: TruncationReason } {
  const lines: string[] = []
  let current = ''
  let chars = 0

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\r') {
      if (value[index + 1] === '\n') {
        index += 1
      }
      lines.push(current)
      current = ''
      if (lines.length >= maxLines) {
        return { lines, truncated: true, reason: 'line' }
      }
      continue
    }

    if (char === '\n') {
      lines.push(current)
      current = ''
      if (lines.length >= maxLines) {
        return { lines, truncated: true, reason: 'line' }
      }
      continue
    }

    if (chars >= maxChars) {
      return finalizeCharPreview(lines, current)
    }

    current += char
    chars += 1
  }

  lines.push(current)
  return { lines, truncated: false, reason: null }
}

function finalizeCharPreview(lines: string[], current: string): {
  lines: string[]
  truncated: true
  reason: 'char'
} {
  return {
    lines: [...lines, current],
    truncated: true,
    reason: 'char',
  }
}

function ClipboardIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden="true"
    >
      <path d="M9 5.5h6" />
      <path d="M9.5 3.5h5a1.5 1.5 0 0 1 1.5 1.5v1.5h-8V5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M7.5 6.5h9a2 2 0 0 1 2 2V18a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6.5 18V8.5a2 2 0 0 1 1-1.8" />
    </svg>
  )
}
