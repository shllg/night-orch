import type { InputHTMLAttributes } from 'react'

export type TextInputType =
  | 'text'
  | 'number'
  | 'password'
  | 'email'
  | 'search'
  | 'url'

export type TextInputTone = 'neutral' | 'info' | 'warning' | 'error'
export type TextInputSize = 'xs' | 'sm' | 'md'

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  type?: TextInputType
  tone?: TextInputTone
  size?: TextInputSize
  fullWidth?: boolean
  ariaLabel?: string
}

export interface TextInputViewModel {
  tone: TextInputTone
  size: TextInputSize
  webClassName: string
}
