import { type FormEvent, type ReactElement, useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { IDisposable } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {
  type ShellSessionDetail,
  type ShellSessionEvent,
  type ShellSessionsSnapshot,
} from '../types/dashboard.js'

interface ShellSessionsPageProps {
  snapshot: ShellSessionsSnapshot | null
  selectedSessionId: string
  selectedSession: ShellSessionDetail | null
  events: ShellSessionEvent[]
  createDraft: {
    cwd: string
  }
  isLoading: boolean
  isMutating: boolean
  socketConnected: boolean
  onSelectSession: (sessionId: string) => void
  onCreateDraftChange: (patch: Partial<{ cwd: string }>) => void
  onCreateSession: (event: FormEvent<HTMLFormElement>) => void
  onCloseSession: () => void
  onTerminalInput: (data: string) => void
  onTerminalResize: (cols: number, rows: number) => void
}

const STATUS_BADGE_CLASS: Record<ShellSessionDetail['status'], string> = {
  running: 'badge-success',
  closed: 'badge-neutral',
}

export function ShellSessionsPage({
  snapshot,
  selectedSessionId,
  selectedSession,
  events,
  createDraft,
  isLoading,
  isMutating,
  socketConnected,
  onSelectSession,
  onCreateDraftChange,
  onCreateSession,
  onCloseSession,
  onTerminalInput,
  onTerminalResize,
}: ShellSessionsPageProps): ReactElement {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputCursorRef = useRef(0)
  const selectedSessionIdRef = useRef(selectedSessionId)
  const onTerminalInputRef = useRef(onTerminalInput)
  const onTerminalResizeRef = useRef(onTerminalResize)

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  useEffect(() => {
    onTerminalInputRef.current = onTerminalInput
  }, [onTerminalInput])

  useEffect(() => {
    onTerminalResizeRef.current = onTerminalResize
  }, [onTerminalResize])

  useEffect(() => {
    const host = terminalHostRef.current
    if (!host) return

    const terminal = new Terminal({
      cursorBlink: true,
      allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      convertEol: false,
      scrollback: 10_000,
      theme: {
        background: '#090f14',
        foreground: '#d4dce4',
        cursor: '#81d4fa',
        black: '#0a1016',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#f472b6',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#f9a8d4',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const reportSize = (): void => {
      fitAddon.fit()
      if (selectedSessionIdRef.current) {
        onTerminalResizeRef.current(terminal.cols, terminal.rows)
      }
    }

    const inputDisposable = terminal.onData((data) => {
      onTerminalInputRef.current(data)
    })

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        reportSize()
      })
      resizeObserver.observe(host)
    }

    reportSize()

    return () => {
      resizeObserver?.disconnect()
      disposeSafely(inputDisposable)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.reset()
    outputCursorRef.current = 0

    if (!selectedSession) {
      terminal.writeln('No shell session selected. Create one to start.')
      return
    }

    terminal.writeln(`Attached to ${selectedSession.shell}`)
    terminal.writeln(`cwd: ${selectedSession.cwd}`)
    terminal.writeln('')

    const fitAddon = fitAddonRef.current
    fitAddon?.fit()
    onTerminalResize(terminal.cols, terminal.rows)
  }, [onTerminalResize, selectedSession])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !selectedSession) return

    const start = Math.max(0, Math.min(outputCursorRef.current, events.length))
    for (let index = start; index < events.length; index += 1) {
      const event = events[index]
      if (!event) continue

      if (event.type === 'output') {
        const text = event.data['text']
        if (typeof text === 'string' && text.length > 0) {
          terminal.write(text)
        }
        continue
      }

      if (event.type === 'status') {
        const message = event.data['message']
        if (typeof message === 'string' && message.length > 0) {
          terminal.writeln(`\r\n[status] ${message}`)
        }
        continue
      }

      if (event.type === 'exit') {
        const code = typeof event.data['exitCode'] === 'number' ? event.data['exitCode'] : null
        const signal = typeof event.data['signal'] === 'number' ? event.data['signal'] : null
        const byRequest = event.data['byRequest'] === true
        const codeLabel = code === null ? 'n/a' : String(code)
        const signalLabel = signal === null ? 'n/a' : String(signal)
        const reason = byRequest ? 'requested' : 'process exit'
        terminal.writeln(`\r\n[exit] code=${codeLabel} signal=${signalLabel} (${reason})`)
      }
    }

    outputCursorRef.current = events.length
  }, [events, selectedSession])

  return (
    <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <section className="card border border-base-300/70 bg-base-100/70 shadow-panel">
        <div className="card-body gap-4 p-4">
          <div>
            <h2 className="card-title text-lg">Browser Shell</h2>
            <p className="text-xs text-base-content/65">
              Sessions run under <code>{snapshot?.homePath ?? '~'}</code>
            </p>
          </div>

          <form className="grid gap-3" onSubmit={onCreateSession}>
            <label className="form-control gap-1.5">
              <span className="label-text text-xs uppercase tracking-wide text-base-content/65">Start Directory</span>
              <input
                className="input input-bordered input-sm w-full"
                value={createDraft.cwd}
                placeholder="~"
                onChange={(event) => {
                  onCreateDraftChange({ cwd: event.target.value })
                }}
                disabled={isMutating}
              />
            </label>

            <button className="btn btn-primary btn-sm" type="submit" disabled={isMutating}>
              Create Shell Session
            </button>
          </form>

          <div className="divider my-1" />

          <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
            {isLoading ? (
              <p className="text-sm text-base-content/65">Loading shell sessions...</p>
            ) : (snapshot?.sessions.length ?? 0) === 0 ? (
              <p className="text-sm text-base-content/65">No shell sessions yet.</p>
            ) : (
              snapshot?.sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`w-full rounded-lg border px-3 py-2 text-left ${
                    selectedSessionId === session.id
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-base-300/70 bg-base-100/45 hover:bg-base-100/70'
                  }`}
                  onClick={() => {
                    onSelectSession(session.id)
                  }}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-medium">shell</span>
                    <span className={`badge badge-xs ${STATUS_BADGE_CLASS[session.status]}`}>{session.status}</span>
                  </div>
                  <p className="truncate text-xs text-base-content/65">{session.cwd}</p>
                  <p className="truncate text-[11px] text-base-content/55">{session.id}</p>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="card border border-base-300/70 bg-base-100/70 shadow-panel">
        <div className="card-body gap-4 p-4">
          {selectedSession ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="card-title text-lg">Shell Session</h2>
                <span className={`badge badge-sm ${STATUS_BADGE_CLASS[selectedSession.status]}`}>
                  {selectedSession.status}
                </span>
                <span className={`badge badge-outline badge-sm ${socketConnected ? '' : 'badge-error'}`}>
                  {socketConnected ? 'ws connected' : 'ws reconnecting'}
                </span>
                <span className="badge badge-outline badge-sm">{selectedSession.shell}</span>
                <button
                  type="button"
                  className="btn btn-outline btn-xs ml-auto"
                  onClick={onCloseSession}
                  disabled={selectedSession.status === 'closed' || isMutating}
                >
                  Close Session
                </button>
              </div>

              <p className="truncate text-xs text-base-content/60">cwd: {selectedSession.cwd}</p>

              <div className="rounded-lg border border-base-300/70 bg-base-100/60 p-2">
                <div
                  ref={terminalHostRef}
                  className="h-[520px] w-full overflow-hidden rounded-md border border-base-content/15 bg-[#090f14] p-1"
                />
              </div>
            </>
          ) : (
            <div className="flex h-[520px] items-center justify-center text-sm text-base-content/60">
              Select or create a shell session to begin.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function disposeSafely(disposable: IDisposable): void {
  try {
    disposable.dispose()
  } catch {
    // no-op
  }
}
