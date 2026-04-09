import { type FormEvent, type ReactElement } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

import { formatMoney } from '../lib/format.js'

interface BudgetOverridesPanelProps {
  baseDailyBudgetUsd: number
  dailyBudgetOverrideUsd: number | null
  effectiveDailyBudgetUsd: number
  todayCostUsd: number
  activeOperation: string | null
  dailyDraft: string
  onDailyDraftChange: (value: string) => void
  onDailySubmit: (event: FormEvent<HTMLFormElement>) => void
  onDailyClear: () => void
  onDailyReset: () => void
  issueDraft: {
    repo: string
    issueNumber: string
    amount: string
  }
  repos: string[]
  onIssueDraftChange: (patch: Partial<BudgetOverridesPanelProps['issueDraft']>) => void
  onIssueSubmit: (event: FormEvent<HTMLFormElement>) => void
  onIssueClear: (event: FormEvent<HTMLFormElement>) => void
}

export function BudgetOverridesPanel({
  baseDailyBudgetUsd,
  dailyBudgetOverrideUsd,
  effectiveDailyBudgetUsd,
  todayCostUsd,
  activeOperation,
  dailyDraft,
  onDailyDraftChange,
  onDailySubmit,
  onDailyClear,
  onDailyReset,
  issueDraft,
  repos,
  onIssueDraftChange,
  onIssueSubmit,
  onIssueClear,
}: BudgetOverridesPanelProps): ReactElement {
  const dailyBusy = activeOperation === 'daily-cost-override:set' || activeOperation === 'daily-cost-override:clear'
  const issueBusy = activeOperation === 'cost-override:set' || activeOperation === 'cost-override:clear'
  const hasDailyOverride = dailyBudgetOverrideUsd !== null

  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-6 sm:p-8">
        <h2 className="card-title text-2xl font-semibold capitalize text-base-content">budget overrides</h2>
        <p className="max-w-3xl text-sm text-base-content/75">
          Unblock runs that were stopped by a cost cap without changing your saved limits. The daily override auto-expires at 00:00 UTC.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-box border border-base-300/60 bg-base-100/40 p-4">
            <h3 className="font-semibold text-base-content">Today&apos;s daily cap</h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-base-content/75">
              <dt>Spent today</dt>
              <dd className="font-mono text-base-content">${formatMoney(todayCostUsd)}</dd>
              <dt>Base cap</dt>
              <dd className="font-mono text-base-content">${formatMoney(baseDailyBudgetUsd)}</dd>
              <dt>Effective cap</dt>
              <dd className="font-mono text-base-content">
                ${formatMoney(effectiveDailyBudgetUsd)}
                {hasDailyOverride && (
                  <span className="ml-2 badge badge-warning badge-xs">override</span>
                )}
              </dd>
            </dl>

            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={onDailySubmit}
            >
              <label className="form-control">
                <span className="label label-text text-xs">New cap (USD)</span>
                <input
                  className="input input-bordered input-xs w-32 font-mono"
                  type="number"
                  min={1}
                  max={10000}
                  step={1}
                  value={dailyDraft}
                  onChange={(event) => onDailyDraftChange(event.target.value)}
                  disabled={dailyBusy}
                  required
                />
              </label>
              <ButtonWeb
                type="submit"
                tone="info"
                size="xs"
                disabled={dailyBusy}
              >
                raise cap
              </ButtonWeb>
              <ButtonWeb
                type="button"
                tone="ghost"
                size="xs"
                onClick={onDailyClear}
                disabled={dailyBusy || !hasDailyOverride}
              >
                clear
              </ButtonWeb>
            </form>
            <p className="mt-2 text-xs text-base-content/60">
              Scoped to the current UTC day. Blocks every queued run until today&apos;s spend hits the new cap.
            </p>
            <ButtonWeb
              type="button"
              tone="error"
              size="xs"
              className="mt-3"
              onClick={onDailyReset}
              disabled={dailyBusy || todayCostUsd <= 0}
            >
              Reset Today&apos;s Costs
            </ButtonWeb>
            <p className="mt-1 text-xs text-base-content/50">
              Zero the daily counters and auto-resume cost-blocked runs.
            </p>
          </div>

          <div className="rounded-box border border-base-300/60 bg-base-100/40 p-4">
            <h3 className="font-semibold text-base-content">Per-issue override</h3>
            <p className="mt-2 text-xs text-base-content/75">
              Grant a single stuck run extra headroom. Replaces the per-run cap <em>and</em> exempts the run from the daily cap.
            </p>

            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={onIssueSubmit}
            >
              <label className="form-control">
                <span className="label label-text text-xs">Repo</span>
                <select
                  className="select select-bordered select-xs w-48"
                  value={issueDraft.repo}
                  onChange={(event) => onIssueDraftChange({ repo: event.target.value })}
                  disabled={issueBusy}
                  required
                >
                  <option value="">(select)</option>
                  {repos.map((repo) => (
                    <option key={repo} value={repo}>{repo}</option>
                  ))}
                </select>
              </label>
              <label className="form-control">
                <span className="label label-text text-xs">Issue #</span>
                <input
                  className="input input-bordered input-xs w-24 font-mono"
                  type="number"
                  min={1}
                  step={1}
                  value={issueDraft.issueNumber}
                  onChange={(event) => onIssueDraftChange({ issueNumber: event.target.value })}
                  disabled={issueBusy}
                  required
                />
              </label>
              <label className="form-control">
                <span className="label label-text text-xs">Amount (USD)</span>
                <input
                  className="input input-bordered input-xs w-28 font-mono"
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={issueDraft.amount}
                  onChange={(event) => onIssueDraftChange({ amount: event.target.value })}
                  disabled={issueBusy}
                  required
                />
              </label>
              <div className="flex gap-2">
                <ButtonWeb
                  type="submit"
                  tone="info"
                  size="xs"
                  disabled={issueBusy}
                >
                  set
                </ButtonWeb>
                <ButtonWeb
                  type="button"
                  tone="ghost"
                  size="xs"
                  onClick={(event) => {
                    event.preventDefault()
                    onIssueClear(event as unknown as FormEvent<HTMLFormElement>)
                  }}
                  disabled={issueBusy}
                >
                  clear
                </ButtonWeb>
              </div>
            </form>
          </div>
        </div>
      </div>
    </section>
  )
}
