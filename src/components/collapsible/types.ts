import type { ReactNode } from 'react'

export type CollapsibleIcon = 'arrow' | 'plus'

export interface CollapsibleProps {
  title: ReactNode
  children: ReactNode
  icon?: CollapsibleIcon
  /** Controlled: caller owns open state. */
  open?: boolean
  /** Uncontrolled: initial open state. Ignored when `open` is defined. */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export interface CollapsibleViewModel {
  icon: CollapsibleIcon
  containerClassName: string
}
