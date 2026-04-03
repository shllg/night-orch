import { type ReactElement } from 'react'

import { type DashboardPage } from '../types/dashboard.js'

interface DashboardHeaderProps {
  activePage: DashboardPage
  onPageChange: (page: DashboardPage) => void
  currentStateLabel: string
  currentStateToneClass: string
}

const PAGES: Array<{ id: DashboardPage, label: string }> = [
  { id: 'issues', label: 'issues' },
  { id: 'stats', label: 'stats' },
  { id: 'projects', label: 'projects' },
  { id: 'settings', label: 'settings' },
]

export function DashboardHeader({
  activePage,
  onPageChange,
  currentStateLabel,
  currentStateToneClass,
}: DashboardHeaderProps): ReactElement {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-base-300/60 bg-base-300/85 backdrop-blur">
      <div className="mx-auto w-full max-w-[1500px] px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-lg font-semibold tracking-wide text-base-content sm:text-xl">night-orch</p>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-base-content/65">Current State</span>
            <span className={`badge badge-sm capitalize ${currentStateToneClass}`}>{currentStateLabel}</span>
          </div>
        </div>

        <div className="-mx-1 overflow-x-auto pb-3">
          <nav className="flex min-w-max gap-2 px-1" aria-label="Dashboard pages">
            {PAGES.map((page) => (
              <button
                key={page.id}
                type="button"
                onClick={() => onPageChange(page.id)}
                className={`btn btn-sm rounded-full px-4 font-medium capitalize ${
                  activePage === page.id
                    ? 'btn-info text-info-content'
                    : 'btn-ghost border border-base-100/40 bg-base-100/35 hover:bg-base-100/55'
                }`}
              >
                {page.label}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </header>
  )
}
