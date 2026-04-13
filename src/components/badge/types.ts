import type { ReactNode } from 'react'

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'ghost'

export type BadgeVariant = 'solid' | 'outline'
export type BadgeSize = 'xs' | 'sm' | 'md'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  variant?: BadgeVariant
  size?: BadgeSize
  capitalize?: boolean
  className?: string
}

export interface BadgeViewModel {
  tone?: BadgeTone
  variant: BadgeVariant
  size: BadgeSize
  webClassName: string
}
