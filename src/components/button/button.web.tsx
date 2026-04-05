import type { ReactElement } from 'react'
import type { ButtonProps } from './types.js'
import { buildButtonViewModel } from './view-model.js'

export function ButtonWeb(props: ButtonProps): ReactElement {
  const button = buildButtonViewModel(props)

  return (
    <button
      type={props.type ?? 'button'}
      className={button.webClassName}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
