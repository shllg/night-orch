import type { ReactNode, SelectHTMLAttributes } from 'react'
import type { Size, Tone } from '../shared-types.js'

export type SelectTone = Extract<Tone, 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error'>
export type SelectSize = Size

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'onSelect'> {
  tone?: SelectTone
  size?: SelectSize
  fullWidth?: boolean
  options?: ReadonlyArray<SelectOption>
  children?: ReactNode
  /** Surface-neutral callback — fired with the selected value. Runs in addition to native onChange. */
  onSelect?: (value: string) => void
  ariaLabel?: string
}

export interface SelectViewModel {
  tone: SelectTone
  size: SelectSize
  webClassName: string
}
