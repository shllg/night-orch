import type { ReactNode } from 'react'
import type { Tone } from '../shared-types.js'

export type CardTone = Extract<Tone, 'neutral' | 'info' | 'success' | 'warning' | 'error'>

export interface CardProps {
  title?: string
  subtitle?: string
  body?: string
  tone?: CardTone
  compact?: boolean
  children?: ReactNode
  actions?: ReactNode
}

export type CardTuiColor = 'gray' | 'cyan' | 'green' | 'yellow' | 'red' | 'white'

export interface CardViewModel {
  tone: CardTone
  webContainerClass: string
  webBodyClass: string
  tuiBorderColor: CardTuiColor
  tuiTitleColor: CardTuiColor
  tuiPaddingX: number
  tuiPaddingY: number
}
