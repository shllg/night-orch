import { type ReactElement } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

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
      <aside className="hidden md:block md:min-h-0">
        <nav
          className="sticky top-[4.55rem] flex h-[calc(100dvh-4.9rem)] min-h-[560px] w-20 flex-col gap-1 border-r border-base-300/70 bg-base-200/45 px-2 py-4 lg:w-56 lg:px-3"
          aria-label="Dashboard pages"
        >
          {PAGES.map((page) => {
            const isActive = activePage === page.id
            return (
              <ButtonWeb
                key={page.id}
                type="button"
                onClick={() => onPageChange(page.id)}
                aria-current={isActive ? 'page' : undefined}
                ariaLabel={page.label}
                title={page.label}
                tone={isActive ? 'primary' : 'ghost'}
                size="sm"
                className={`h-11 w-full rounded-lg border border-transparent px-2 ${
                  isActive
                    ? 'text-primary-content'
                    : 'bg-base-100/25 text-base-content/75 hover:bg-base-100/45 hover:text-base-content'
                } justify-center lg:justify-start lg:gap-3 lg:px-3`}
              >
                <page.Icon className="size-4 shrink-0" />
                <span className="hidden text-sm capitalize lg:inline">{page.label}</span>
              </ButtonWeb>
            )
          })}
        </nav>
      </aside>

      <nav
        className="dock dock-sm shadow-nav-dock z-40 border-t border-base-300/70 bg-base-200/95 backdrop-blur md:hidden"
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
              className={isActive ? 'dock-active text-primary' : 'text-base-content/70'}
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a1.3 1.3 0 0 0 .9 1.25l.12.03a1.9 1.9 0 0 1 0 3.44l-.12.04A1.3 1.3 0 0 0 19 18a1.3 1.3 0 0 0-.23.75l.01.12a1.9 1.9 0 0 1-2.98 1.72l-.1-.07a1.3 1.3 0 0 0-1.5 0l-.1.07a1.9 1.9 0 0 1-2.98-1.72l.01-.12a1.3 1.3 0 0 0-.23-.75 1.3 1.3 0 0 0-.9-.56l-.12-.04a1.9 1.9 0 0 1 0-3.44l.12-.03A1.3 1.3 0 0 0 9 12a1.3 1.3 0 0 0-.23-.75l-.01-.12a1.9 1.9 0 0 1 2.98-1.72l.1.07a1.3 1.3 0 0 0 1.5 0l.1-.07a1.9 1.9 0 0 1 2.98 1.72l-.01.12c0 .27.08.53.23.75.2.28.51.48.86.56l.12.03A1.3 1.3 0 0 0 19 12Z" />
      </>
    ),
  })
}
