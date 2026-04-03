import { type ReactElement } from 'react'

import { describeEventData, formatTimestamp } from '../lib/format.js'
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
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            {runEvents.slice(-150).map((event) => (
              <div key={event.id} className="rounded-box border border-base-300/70 bg-base-100/80 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                  <span>{formatTimestamp(event.timestamp)}</span>
                  <span>{event.phase} / {event.role}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-info">{event.type}</p>
                <p className="mt-1 text-xs text-base-content/85">{describeEventData(event.data)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
