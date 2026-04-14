import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react'
import type { Size, Tone } from '../shared-types.js'

export type ButtonTone = Exclude<Tone, 'secondary' | 'accent'>
export type ButtonVariant = 'solid' | 'outline'
export type ButtonSize = Size
export type ButtonShape = 'default' | 'circle'
export type ButtonTuiColor = 'white' | 'blue' | 'cyan' | 'red' | 'gray' | 'green' | 'yellow'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'onClick' | 'type'> {
  children: ReactNode
  tone?: ButtonTone
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  fullWidth?: boolean
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
