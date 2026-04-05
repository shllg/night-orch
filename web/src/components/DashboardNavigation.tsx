import { type ReactElement } from 'react'

import { type DashboardPage } from '../types/dashboard.js'

interface DashboardNavigationProps {
  activePage: DashboardPage
  onPageChange: (page: DashboardPage) => void
}

interface IconProps {
  className?: string
}

interface PageDefinition {
  id: DashboardPage
  label: string
  shortLabel: string
  Icon: (props: IconProps) => ReactElement
}

const PAGES: PageDefinition[] = [
  { id: 'issues', label: 'issues', shortLabel: 'issues', Icon: IssuesIcon },
  { id: 'stats', label: 'stats', shortLabel: 'stats', Icon: StatsIcon },
  { id: 'projects', label: 'projects', shortLabel: 'projects', Icon: ProjectsIcon },
  { id: 'settings', label: 'settings', shortLabel: 'settings', Icon: SettingsIcon },
]

export function DashboardNavigation({ activePage, onPageChange }: DashboardNavigationProps): ReactElement {
  return (
    <>
      <aside className="hidden md:block">
        <nav
          className="sticky top-28 flex w-16 flex-col gap-1 rounded-box border border-base-300/70 bg-base-200/65 p-1.5 shadow-panel backdrop-blur lg:w-52"
          aria-label="Dashboard pages"
        >
          {PAGES.map((page) => {
            const isActive = activePage === page.id
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => onPageChange(page.id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={page.label}
                title={page.label}
                className={`btn btn-sm h-11 w-full rounded-lg border border-transparent px-2 ${
                  isActive
                    ? 'btn-info text-info-content'
                    : 'btn-ghost bg-base-100/30 text-base-content/75 hover:bg-base-100/50 hover:text-base-content'
                } justify-center lg:justify-start lg:gap-3 lg:px-3`}
              >
                <page.Icon className="size-4 shrink-0" />
                <span className="hidden text-sm capitalize lg:inline">{page.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <nav
        className="dock dock-sm z-40 border-t border-base-300/70 bg-base-200/95 backdrop-blur md:hidden"
        aria-label="Dashboard pages"
      >
        {PAGES.map((page) => {
          const isActive = activePage === page.id
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onPageChange(page.id)}
              aria-label={page.label}
              title={page.label}
              className={isActive ? 'dock-active text-info' : 'text-base-content/70'}
              aria-current={isActive ? 'page' : undefined}
            >
              <page.Icon className="size-[1.1rem]" />
              <span className="dock-label text-[11px] capitalize">{page.shortLabel}</span>
            </button>
          )
        })}
      </nav>
    </>
  )
}

function baseIcon({ className, children }: { className?: string, children: ReactElement }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-4'}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function IssuesIcon({ className }: IconProps): ReactElement {
  return baseIcon({
    className,
    children: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M7 9h10" />
        <path d="M7 13h6.5" />
      </>
    ),
  })
}

function StatsIcon({ className }: IconProps): ReactElement {
  return baseIcon({
    className,
    children: (
      <>
        <path d="M4 19.5h16" />
        <rect x="6.25" y="11.25" width="2.5" height="6.25" rx="1" />
        <rect x="10.75" y="8.25" width="2.5" height="9.25" rx="1" />
        <rect x="15.25" y="5.25" width="2.5" height="12.25" rx="1" />
      </>
    ),
  })
}

function ProjectsIcon({ className }: IconProps): ReactElement {
  return baseIcon({
    className,
    children: (
      <>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="M3.75 9.5h16.5" />
        <path d="M8.25 5v4.5" />
      </>
    ),
  })
}

function SettingsIcon({ className }: IconProps): ReactElement {
  return baseIcon({
    className,
    children: (
      <>
        <circle cx="12" cy="12" r="2.75" />
        <path d="M12 4.2v1.6" />
        <path d="M12 18.2v1.6" />
        <path d="m5.9 5.9 1.15 1.15" />
        <path d="m16.95 16.95 1.15 1.15" />
        <path d="M4.2 12h1.6" />
        <path d="M18.2 12h1.6" />
        <path d="m5.9 18.1 1.15-1.15" />
        <path d="m16.95 7.05 1.15-1.15" />
      </>
    ),
  })
}
