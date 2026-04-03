import { type ReactElement } from 'react'

import { formatTimestamp } from '../lib/format.js'

interface DashboardHeaderProps {
  pollIntervalSeconds: number | null
  generatedAt: string | null
  socketConnected: boolean
}

export function DashboardHeader({ pollIntervalSeconds, generatedAt, socketConnected }: DashboardHeaderProps): ReactElement {
  return (
    <header className="navbar rounded-box border border-base-300/60 bg-base-200/60 px-4 py-3 shadow-panel backdrop-blur sm:px-5">
      <div className="flex-1">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-info/80">night-orch</p>
          <h1 className="text-2xl font-semibold text-base-content sm:text-3xl">Web Control Center</h1>
          <p className="text-sm text-base-content/70">
            Poll interval {pollIntervalSeconds ?? '-'}s
          </p>
        </div>
      </div>
      <div className="flex-none">
        <div className="flex flex-wrap justify-end gap-2">
          <span className={`badge badge-outline gap-1 ${socketConnected ? 'badge-success' : 'badge-error'}`}>
            {socketConnected ? 'Live stream online' : 'Reconnecting stream'}
          </span>
          <span className="badge badge-neutral badge-outline">
            Last refresh {generatedAt ? formatTimestamp(generatedAt) : '--'}
          </span>
        </div>
      </div>
    </header>
  )
}
