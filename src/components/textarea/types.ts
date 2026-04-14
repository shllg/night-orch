import type { TextareaHTMLAttributes } from 'react'
import type { Size, Tone } from '../shared-types.js'

export type TextAreaTone = Extract<Tone, 'neutral' | 'info' | 'success' | 'warning' | 'error'>
export type TextAreaSize = Size

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  tone?: TextAreaTone
  size?: TextAreaSize
  fullWidth?: boolean
  ariaLabel?: string
}

export interface TextAreaViewModel {
  tone: TextAreaTone
  size: TextAreaSize
  webClassName: string
}
