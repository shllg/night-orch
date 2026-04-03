import { type ReactElement } from 'react'

interface ActionButtonProps {
  label: string
  busy: boolean
  onClick?: () => void
  submit?: boolean
}

export function ActionButton({ label, busy, onClick, submit = false }: ActionButtonProps): ReactElement {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      onClick={onClick}
      className={`btn btn-info btn-sm w-full justify-between ${submit ? '' : 'btn-outline'}`}
      disabled={busy}
    >
      {busy ? 'Working...' : label}
    </button>
  )
}
