import type { ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  title?: string
  description?: string
  children?: ReactNode
  actions?: ReactNode
  onClose?: () => void
  blocking?: boolean
  closeOnBackdropClick?: boolean
  ariaLabel?: string
  closeButtonLabel?: string
  widthClassName?: string
}
