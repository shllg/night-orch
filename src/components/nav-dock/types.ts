import type { NavItem } from '../nav-menu/types.js'

export type { NavItem }

export interface NavDockProps {
  items: ReadonlyArray<NavItem>
  ariaLabel?: string
  className?: string
  /** When true, adds `pb-[env(safe-area-inset-bottom)]` for iOS safe area. */
  safeArea?: boolean
  /** Dock size. Maps to DaisyUI `dock-xs|sm|md|lg`. */
  size?: 'xs' | 'sm' | 'md' | 'lg'
}
