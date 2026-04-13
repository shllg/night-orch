import { type FormEvent, type ReactElement } from 'react'
import { BadgeWeb } from '../../../src/components/badge/badge.web.js'
import { ButtonWeb } from '../../../src/components/button/button.web.js'
import {
  type InteractiveAgentSessionDetail,
  type InteractiveAgentSessionEvent,
  type InteractiveAgentSessionsSnapshot,
  type InteractiveAgentType,
} from '../types/dashboard.js'

interface AgentSessionsPageProps {
  snapshot: InteractiveAgentSessionsSnapshot | null
  selectedSessionId: string
  selectedSession: InteractiveAgentSessionDetail | null
  events: InteractiveAgentSessionEvent[]
  promptDraft: string
  createDraft: {
    agent: InteractiveAgentType
    profileName: string
  }
  isLoading: boolean
  isMutating: boolean
  onSelectSession: (sessionId: string) => void
  onCreateDraftChange: (patch: Partial<{ agent: InteractiveAgentType; profileName: string }>) => void
  onPromptDraftChange: (value: string) => void
  onCreateSession: (event: FormEvent<HTMLFormElement>) => void
  onSendPrompt: (event: FormEvent<HTMLFormElement>) => void
  onCloseSession: () => void
}

const STATUS_BADGE_CLASS: Record<InteractiveAgentSessionDetail['status'], string> = {
  idle: 'badge-neutral',
  running: 'badge-info',
  failed: 'badge-error',
  closed: 'badge-ghost',
}

export function AgentSessionsPage({
  snapshot,
  selectedSessionId,
  selectedSession,
  events,
  promptDraft,
  createDraft,
  isLoading,
  isMutating,
  onSelectSession,
  onCreateDraftChange,
  onPromptDraftChange,
  onCreateSession,
  onSendPrompt,
  onCloseSession,
}: AgentSessionsPageProps): ReactElement {
  const availableProfiles = (snapshot?.profiles ?? []).filter((profile) => profile.type === createDraft.agent)

  return (
    <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <section className="card border border-base-300/70 bg-base-100/70 shadow-panel">
        <div className="card-body gap-4 p-4">
          <div>
            <h2 className="card-title text-lg">Interactive Agent</h2>
            <p className="text-xs text-base-content/65">
              Runs in <code>{snapshot?.workspacePath ?? 'workspace'}</code>
            </p>
          </div>

          <form className="grid gap-3" onSubmit={onCreateSession}>
            <label className="form-control gap-1.5">
              <span className="label-text text-xs uppercase tracking-wide text-base-content/65">Agent</span>
              <select
                className="select select-bordered select-sm w-full"
                value={createDraft.agent}
                onChange={(event) => {
                  onCreateDraftChange({
                    agent: event.target.value as InteractiveAgentType,
                    profileName: '',
                  })
                }}
                disabled={isMutating}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>

            <label className="form-control gap-1.5">
              <span className="label-text text-xs uppercase tracking-wide text-base-content/65">Profile (optional)</span>
              <select
                className="select select-bordered select-sm w-full"
                value={createDraft.profileName}
                onChange={(event) => {
                  onCreateDraftChange({ profileName: event.target.value })
                }}
                disabled={isMutating}
              >
                <option value="">Auto-select by type</option>
                {availableProfiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>

            <ButtonWeb type="submit" tone="primary" size="sm" disabled={isMutating}>
              Create Session
            </ButtonWeb>
          </form>

          <div className="divider my-1" />

          <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
            {isLoading ? (
              <p className="text-sm text-base-content/65">Loading sessions...</p>
            ) : (snapshot?.sessions.length ?? 0) === 0 ? (
              <p className="text-sm text-base-content/65">No sessions yet.</p>
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
                    <span className="font-medium capitalize">{session.agent}</span>
                    <BadgeWeb size="xs" className={STATUS_BADGE_CLASS[session.status]}>
                      {session.status}
                    </BadgeWeb>
                  </div>
                  <p className="truncate text-xs text-base-content/65">{session.id}</p>
                  <p className="text-[11px] text-base-content/55">turns: {session.turnCount}</p>
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
                <h2 className="card-title text-lg capitalize">{selectedSession.agent} Session</h2>
                <BadgeWeb size="sm" className={STATUS_BADGE_CLASS[selectedSession.status]}>
                  {selectedSession.status}
                </BadgeWeb>
                <BadgeWeb size="sm" variant="outline">
                  turns {selectedSession.turnCount}
                </BadgeWeb>
                <ButtonWeb
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={onCloseSession}
                  disabled={selectedSession.status === 'running' || isMutating}
                >
                  Close Session
                </ButtonWeb>
              </div>

              {selectedSession.lastError && (
                <div className="alert alert-error py-2 text-sm">
                  <span>{selectedSession.lastError}</span>
                </div>
              )}

              <div className="rounded-lg border border-base-300/70 bg-base-100/60 p-2">
                <div className="h-[360px] space-y-2 overflow-y-auto rounded-md bg-base-100/70 p-2">
                  {events.length === 0 ? (
                    <p className="text-sm text-base-content/60">No output yet. Send a prompt to start streaming.</p>
                  ) : (
                    events.map((event) => (
                      <div key={event.id} className="text-xs leading-relaxed">
                        <span className="mr-2 text-base-content/45">{formatTime(event.timestamp)}</span>
                        <span className={`mr-2 font-semibold ${eventToneClass(event.type)}`}>{event.type}</span>
                        <span className="whitespace-pre-wrap break-words text-base-content/85">
                          {renderEventText(event)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <form className="grid gap-2" onSubmit={onSendPrompt}>
                <textarea
                  className="textarea textarea-bordered min-h-[96px] w-full text-sm"
                  placeholder="Ask the agent to inspect files, run diagnostics, or call MCP tools..."
                  value={promptDraft}
                  onChange={(event) => {
                    onPromptDraftChange(event.target.value)
                  }}
                  disabled={selectedSession.status === 'running' || selectedSession.status === 'closed' || isMutating}
                />
                <div className="flex justify-end">
                  <ButtonWeb
                    type="submit"
                    tone="primary"
                    size="sm"
                    disabled={selectedSession.status === 'running' || selectedSession.status === 'closed' || isMutating}
                  >
                    Send Prompt
                  </ButtonWeb>
                </div>
              </form>
            </>
          ) : (
            <div className="flex h-[520px] items-center justify-center text-sm text-base-content/60">
              Select or create a session to begin.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString(undefined, { hour12: false })
}

function eventToneClass(eventType: InteractiveAgentSessionEvent['type']): string {
  switch (eventType) {
    case 'status':
      return 'text-info'
    case 'stderr':
      return 'text-error'
    case 'tool_call':
      return 'text-secondary'
    case 'text':
      return 'text-success'
    default:
      return 'text-base-content/65'
  }
}

function renderEventText(event: InteractiveAgentSessionEvent): string {
  if (typeof event.data['message'] === 'string') {
    return event.data['message']
  }
  if (typeof event.data['text'] === 'string') {
    return event.data['text']
  }
  if (typeof event.data['toolName'] === 'string') {
    const args = typeof event.data['toolArgs'] === 'string' ? ` ${event.data['toolArgs']}` : ''
    return `${event.data['toolName']}${args}`
  }
  return JSON.stringify(event.data)
}
