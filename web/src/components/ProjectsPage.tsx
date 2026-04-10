import { type ReactElement } from 'react'

import { formatTimestamp } from '../lib/format.js'
import { type ProjectsSnapshot } from '../types/dashboard.js'

interface ProjectsPageProps {
  snapshot: ProjectsSnapshot | null
  isLoading: boolean
  onOpenRepo: (repo: string) => void
}

export function ProjectsPage({ snapshot, isLoading, onOpenRepo }: ProjectsPageProps): ReactElement {
  const repos = snapshot?.repos ?? []

  if (isLoading && !snapshot) {
    return (
      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-5">
          <div className="skeleton h-5 w-36" />
          <div className="mt-4 space-y-2">
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
          </div>
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-6">
          <h2 className="card-title text-2xl font-semibold text-base-content">Projects</h2>
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Project configuration is currently unavailable.</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="card-title text-lg">Projects ({repos.length})</h2>
          <span className="text-[11px] text-base-content/60">
            Updated {formatTimestamp(snapshot.generatedAt)}
          </span>
        </div>

        {repos.length === 0 ? (
          <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
            <span>No repositories are configured.</span>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {repos.map((repo) => (
              <button
                key={repo.repo}
                type="button"
                onClick={() => onOpenRepo(repo.repo)}
                className="rounded-box border border-base-300/70 bg-base-100/55 px-3 py-3 text-left transition-colors hover:border-info/45 hover:bg-base-100/80"
              >
                <p className="text-sm font-semibold text-base-content">{repo.repo}</p>
                <p className="mt-0.5 text-xs text-base-content/70">
                  {repo.forge}
                  {'  ·  '}
                  base {repo.baseBranch}
                </p>
                <p className="mt-0.5 text-xs text-base-content/55">
                  workflow {repo.workflow ?? 'default'}
                  {'  ·  '}
                  coder {repo.defaults.coder}
                </p>
                <p className="mt-2 text-[11px] text-info/85">Open project details</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
