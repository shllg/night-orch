import type { HTMLAttributes, ReactNode } from 'react'

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

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className'> {
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
