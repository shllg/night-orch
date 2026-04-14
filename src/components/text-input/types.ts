import type { InputHTMLAttributes } from 'react'
import type { Size } from '../shared-types.js'

export type TextInputType =
  | 'text'
  | 'number'
  | 'password'
  | 'email'
  | 'search'
  | 'url'

export type TextInputTone = 'neutral' | 'info' | 'warning' | 'error' | 'success'
export type TextInputSize = Size

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
