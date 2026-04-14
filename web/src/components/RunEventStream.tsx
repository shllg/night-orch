import { type ReactElement } from 'react'

import { LogLineWeb } from '../../../src/components/log-line/log-line.web.js'
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
          <div className="mt-3 max-h-80 overflow-y-auto rounded-box border border-base-300/70 bg-base-100/80 p-3 pr-1">
            {runEvents.slice(-150).map((event) => (
              <LogLineWeb
                key={event.id}
                timestamp={formatTimestamp(event.timestamp)}
                source={event.source === 'system' ? 'system' : 'agent'}
                role={event.source === 'system' ? undefined : event.role ?? undefined}
                message={describeRunEvent(event)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
