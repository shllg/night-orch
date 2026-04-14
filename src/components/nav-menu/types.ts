import type { ReactNode } from 'react'

export interface NavItem {
  id: string
  label: string
  shortLabel?: string
  icon?: ReactNode
  isActive?: boolean
  disabled?: boolean
  ariaCurrent?: 'page' | 'step' | 'location'
  onClick?: () => void
}

export interface NavMenuProps {
  items: ReadonlyArray<NavItem>
  ariaLabel?: string
  className?: string
  /** Compact mode collapses labels, keeping only icons. */
  compact?: boolean
}
