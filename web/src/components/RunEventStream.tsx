import { type ReactElement } from 'react'

import { describeRunEvent, formatTimestamp } from '../lib/format.js'
import { type RunEvent, type RunSummary } from '../types/dashboard.js'

interface RunEventStreamProps {
  selectedRunId: string
  selectedRun: RunSummary | null
  runEvents: RunEvent[]
}

export function RunEventStream({ selectedRunId, selectedRun, runEvents }: RunEventStreamProps): ReactElement {
  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title text-lg">Run Event Stream</h2>
          {selectedRun && (
            <p className="text-xs text-base-content/70">
              {selectedRun.repo} #{selectedRun.issue}
              {selectedRun.hasRun ? ` (${selectedRun.runId})` : ''}
            </p>
          )}
        </div>

        {!selectedRunId ? (
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Select a run to stream live events.</span>
          </div>
        ) : selectedRun && !selectedRun.hasRun ? (
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>This issue is tracked but has no run yet.</span>
          </div>
        ) : runEvents.length === 0 ? (
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>No events yet for this run.</span>
          </div>
        ) : (
          <div className="mt-3 max-h-80 overflow-y-auto rounded-box border border-base-300/70 bg-base-100/80 p-3 pr-1 font-mono text-xs">
            {runEvents.slice(-150).map((event) => (
              <div key={event.id} className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 border-b border-base-300/30 py-1 last:border-b-0">
                <span className="text-base-content/55">{formatTimestamp(event.timestamp)}</span>
                <span className={event.source === 'system' ? 'text-secondary' : 'text-info'}>
                  {event.source === 'system' ? 'system' : event.role ?? 'agent'}
                </span>
                <span className="min-w-0 break-words text-base-content/85">
                  {describeRunEvent(event)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
