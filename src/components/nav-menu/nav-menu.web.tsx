import type { ReactElement } from 'react'
import { ButtonWeb } from '../button/button.web.js'
import type { NavMenuProps } from './types.js'

export function NavMenuWeb(props: NavMenuProps): ReactElement {
  const containerTokens = ['flex', 'flex-col', 'gap-1']
  if (props.className !== undefined && props.className.trim().length > 0) {
    containerTokens.push(props.className.trim())
  }

  return (
    <nav className={containerTokens.join(' ')} aria-label={props.ariaLabel}>
      {props.items.map((item) => {
        const isActive = Boolean(item.isActive)
        const buttonClasses = [
          'h-11 w-full rounded-lg border border-transparent px-2',
          isActive
            ? 'text-primary-content'
            : 'bg-base-100/25 text-base-content/75 hover:bg-base-100/45 hover:text-base-content',
          props.compact === true ? 'justify-center' : 'justify-center lg:justify-start lg:gap-3 lg:px-3',
        ].join(' ')

        return (
          <ButtonWeb
            key={item.id}
            type="button"
            tone={isActive ? 'primary' : 'ghost'}
            size="sm"
            onClick={item.onClick}
            disabled={item.disabled}
            ariaLabel={item.label}
            title={item.label}
            aria-current={isActive ? item.ariaCurrent ?? 'page' : undefined}
            className={buttonClasses}
          >
            {item.icon}
            {props.compact !== true && (
              <span className="hidden text-sm capitalize lg:inline">{item.label}</span>
            )}
          </ButtonWeb>
        )
      })}
    </nav>
  )
}
