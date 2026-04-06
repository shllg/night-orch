import { type ReactElement } from 'react'

interface DashboardHeaderProps {
  currentStateLabel: string
  currentStateToneClass: string
  isWorking: boolean
  socketConnected: boolean
  lastRefreshAt: string | null
  pollIntervalSeconds: number | null
  reposCount: number
  activeRuns: number
  runningRuns: number
  queuedRuns: number
  frontendVersion: string
  frontendGitSha: string
  backendVersion: string
  backendGitSha: string | null
  operationsEnabled: boolean
  activeOperation: string | null
  isRefreshing: boolean
  onRefresh: () => void
  onPoll: () => void
  onSync: () => void
  onGoToSettings: () => void
}

function normalizeShaForCompare(sha: string | null): string {
  const normalized = (sha ?? 'unknown').trim().toLowerCase()
  return normalized.length > 0 ? normalized : 'unknown'
}

function shasRepresentSameCommit(frontendSha: string, backendSha: string | null): boolean {
  const frontendNormalized = normalizeShaForCompare(frontendSha)
  const backendNormalized = normalizeShaForCompare(backendSha)

  if (frontendNormalized === 'unknown' || backendNormalized === 'unknown') {
    return frontendNormalized === backendNormalized
  }

  return (
    frontendNormalized === backendNormalized
    || frontendNormalized.startsWith(backendNormalized)
    || backendNormalized.startsWith(frontendNormalized)
  )
}

function shortSha(sha: string | null): string {
  const normalized = (sha ?? 'unknown').trim()
  if (normalized.length === 0) return 'unknown'
  return normalized.toLowerCase() === 'unknown' ? 'unknown' : normalized.slice(0, 12)
}

export function DashboardHeader({
  currentStateLabel,
  currentStateToneClass,
  isWorking,
  socketConnected,
  lastRefreshAt,
  pollIntervalSeconds,
  reposCount,
  activeRuns,
  runningRuns,
  queuedRuns,
  frontendVersion,
  frontendGitSha,
  backendVersion,
  backendGitSha,
  operationsEnabled,
  activeOperation,
  isRefreshing,
  onRefresh,
  onPoll,
  onSync,
  onGoToSettings,
}: DashboardHeaderProps): ReactElement {
  const frontendShortSha = shortSha(frontendGitSha)
  const backendShortSha = shortSha(backendGitSha)
  const shasMatch = shasRepresentSameCommit(frontendGitSha, backendGitSha)
  const mutationBusy = activeOperation !== null
  const canRunMutations = operationsEnabled && !mutationBusy
  const lastRefreshLabel = formatLastRefresh(lastRefreshAt)
  const buildLabel = shasMatch
    ? `v${backendVersion} · ${backendShortSha}`
    : `fe ${frontendShortSha} / be ${backendShortSha}`

  return (
    <header className="sticky top-0 z-50 border-b border-base-300/60 bg-base-300/88 backdrop-blur">
      <div className="mx-auto w-full max-w-[1500px] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 py-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-lg font-semibold tracking-wide text-base-content sm:text-xl">night-orch</p>
              <span className="text-[11px] font-mono text-base-content/65">web v{frontendVersion} · api v{backendVersion}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/75">
              <span className="text-[10px] uppercase tracking-[0.22em] text-base-content/65">State</span>
              <span className={`badge badge-sm capitalize ${currentStateToneClass} ${isWorking ? 'orch-working-pulse' : ''}`}>
                {currentStateLabel}
              </span>
              <span className={socketConnected ? 'text-success' : 'text-warning'}>
                {socketConnected ? 'stream online' : 'stream reconnecting'}
              </span>
              <span>Last refresh {lastRefreshLabel}</span>
              <span>Poll {pollIntervalSeconds ?? '--'}s</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <StatPill label="active" value={activeRuns} />
              <StatPill label="running" value={runningRuns} />
              <StatPill label="queued" value={queuedRuns} />
              <StatPill label="repos" value={reposCount} />
              <StatPill label="git" value={buildLabel} monospace />
            </div>
          </div>

          <div className="flex items-center gap-2 self-end lg:self-start">
            <ActionIconButton
              label={isRefreshing ? 'Refreshing...' : 'Refresh data'}
              onClick={onRefresh}
              disabled={isRefreshing}
              busy={isRefreshing}
            >
              <RefreshIcon />
            </ActionIconButton>
            <ActionIconButton
              label={activeOperation === 'poll' ? 'Polling...' : 'Trigger poll'}
              onClick={onPoll}
              disabled={!canRunMutations}
              busy={activeOperation === 'poll'}
            >
              <PollIcon />
            </ActionIconButton>
            <ActionIconButton
              label={activeOperation === 'sync' ? 'Syncing...' : 'Run sync'}
              onClick={onSync}
              disabled={!canRunMutations}
              busy={activeOperation === 'sync'}
            >
              <SyncIcon />
            </ActionIconButton>
            <ActionIconButton label="Open settings" onClick={onGoToSettings}>
              <SettingsIcon />
            </ActionIconButton>
          </div>
        </div>
      </div>
    </header>
  )
}

function formatLastRefresh(value: string | null): string {
  if (!value) return '--'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString()
}

function StatPill({
  label,
  value,
  monospace = false,
}: {
  label: string
  value: number | string
  monospace?: boolean
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-base-100/45 bg-base-100/35 px-1.5 py-0.5">
      <span className="text-[9px] uppercase tracking-[0.16em] text-base-content/65">{label}</span>
      <span className={monospace ? 'font-mono text-base-content' : 'font-semibold text-base-content'}>
        {value}
      </span>
    </span>
  )
}

function ActionIconButton({
  label,
  onClick,
  disabled = false,
  busy = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-circle border border-base-100/45 bg-base-100/30 hover:bg-base-100/50"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {busy ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : children}
    </button>
  )
}

function svgIcon(children: ReactElement): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function RefreshIcon(): ReactElement {
  return svgIcon(
    <>
      <path d="M20 11a8 8 0 0 0-13.8-5.4" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 13.8 5.4" />
      <path d="M20 20v-4h-4" />
    </>,
  )
}

function PollIcon(): ReactElement {
  return svgIcon(
    <>
      <circle cx="12" cy="12" r="7.25" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="m20 4-3.4 3.4" />
      <path d="M20 7V4h-3" />
    </>,
  )
}

function SyncIcon(): ReactElement {
  return svgIcon(
    <>
      <path d="M10.2 6.2a4.4 4.4 0 1 0-2.8 6.5" />
      <path d="M10.4 8.8V5.7H7.3" />
      <path d="M13.8 17.8a4.4 4.4 0 1 0 2.8-6.5" />
      <path d="M13.6 15.2v3.1h3.1" />
    </>,
  )
}

function SettingsIcon(): ReactElement {
  return svgIcon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a1.3 1.3 0 0 0 .9 1.25l.12.03a1.9 1.9 0 0 1 0 3.44l-.12.04A1.3 1.3 0 0 0 19 18a1.3 1.3 0 0 0-.23.75l.01.12a1.9 1.9 0 0 1-2.98 1.72l-.1-.07a1.3 1.3 0 0 0-1.5 0l-.1.07a1.9 1.9 0 0 1-2.98-1.72l.01-.12a1.3 1.3 0 0 0-.23-.75 1.3 1.3 0 0 0-.9-.56l-.12-.04a1.9 1.9 0 0 1 0-3.44l.12-.03A1.3 1.3 0 0 0 9 12a1.3 1.3 0 0 0-.23-.75l-.01-.12a1.9 1.9 0 0 1 2.98-1.72l.1.07a1.3 1.3 0 0 0 1.5 0l.1-.07a1.9 1.9 0 0 1 2.98 1.72l-.01.12c0 .27.08.53.23.75.2.28.51.48.86.56l.12.03A1.3 1.3 0 0 0 19 12Z" />
    </>,
  )
}
