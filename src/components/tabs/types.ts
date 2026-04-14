import type { ReactNode } from 'react'
import type { Size } from '../shared-types.js'

/**
 * DaisyUI v5 tab variants. Note: v5 renamed `tabs-bordered` → `tabs-border`
 * and `tabs-lifted` → `tabs-lift`. The lookup table below encodes v5.
 */
export type TabsVariant = 'default' | 'box' | 'lift' | 'border'
export type TabsSize = Size

export interface TabItem {
  id: string
  label: ReactNode
  disabled?: boolean
}

export interface TabsProps {
  tabs: ReadonlyArray<TabItem>
  activeId: string
  /** Fired with the newly-selected tab id. */
  onChange: (id: string) => void
  variant?: TabsVariant
  size?: TabsSize
  className?: string
  ariaLabel?: string
}

export interface TabsViewModel {
  variant: TabsVariant
  size: TabsSize
  containerClassName: string
  tabClassName(isActive: boolean): string
}
