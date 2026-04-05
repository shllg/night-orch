import { type ReactElement } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

interface ActionButtonProps {
  label: string
  busy: boolean
  onClick?: () => void
  submit?: boolean
}

export function ActionButton({ label, busy, onClick, submit = false }: ActionButtonProps): ReactElement {
  return (
    <ButtonWeb
      type={submit ? 'submit' : 'button'}
      onClick={onClick}
      tone="info"
      size="sm"
      variant={submit ? 'solid' : 'outline'}
      fullWidth
      className="justify-between"
      disabled={busy}
    >
      {busy ? 'Working...' : label}
    </ButtonWeb>
  )
}
