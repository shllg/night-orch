import type { ReactElement } from 'react'
import type { NavDockProps } from './types.js'

const SIZE_CLASS: Record<NonNullable<NavDockProps['size']>, string | null> = {
  xs: 'dock-xs',
  sm: 'dock-sm',
  md: null,
  lg: 'dock-lg',
}

export function NavDockWeb(props: NavDockProps): ReactElement {
  const size = props.size ?? 'sm'
  const tokens = ['dock', SIZE_CLASS[size]]
  if (props.safeArea === true) {
    tokens.push('pb-[env(safe-area-inset-bottom)]')
  }
  if (props.className !== undefined && props.className.trim().length > 0) {
    tokens.push(props.className.trim())
  }
  const className = tokens.filter((token): token is string => token !== null).join(' ')

  return (
    <nav className={className} aria-label={props.ariaLabel}>
      {props.items.map((item) => {
        const isActive = Boolean(item.isActive)
        return (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            disabled={item.disabled}
            aria-label={item.label}
            title={item.label}
            aria-current={isActive ? item.ariaCurrent ?? 'page' : undefined}
            className={isActive ? 'dock-active text-primary' : 'text-base-content/70'}
          >
            {item.icon}
            <span className="dock-label text-[11px] capitalize">
              {item.shortLabel ?? item.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
