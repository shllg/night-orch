import type { MouseEventHandler, ReactNode } from 'react'

export type ButtonTone = 'neutral' | 'primary' | 'info' | 'error' | 'ghost'
export type ButtonVariant = 'solid' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md'
export type ButtonShape = 'default' | 'circle'
export type ButtonTuiColor = 'white' | 'blue' | 'cyan' | 'red' | 'gray'

export interface ButtonProps {
  children: ReactNode
  tone?: ButtonTone
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  fullWidth?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  className?: string
  ariaLabel?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
}

export interface ButtonViewModel {
  tone: ButtonTone
  variant: ButtonVariant
  size: ButtonSize
  shape: ButtonShape
  webClassName: string
  tuiColor: ButtonTuiColor
}
