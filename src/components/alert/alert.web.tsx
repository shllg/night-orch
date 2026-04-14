import type { ReactElement } from 'react'
import type { AlertProps } from './types.js'
import { buildAlertViewModel } from './view-model.js'

export function AlertWeb(props: AlertProps): ReactElement {
  const vm = buildAlertViewModel(props)
  const role = props.role ?? 'status'
  const ariaLive = role === 'alert' ? 'assertive' : role === 'status' ? 'polite' : undefined

  return (
    <div
      className={vm.webClassName}
      role={role === 'none' ? undefined : role}
      aria-live={ariaLive}
    >
      {props.icon !== undefined && <span className="shrink-0">{props.icon}</span>}
      <div className="min-w-0 flex-1">
        {props.title !== undefined && (
          <p className="font-medium leading-tight">{props.title}</p>
        )}
        {props.children !== undefined && (
          <div className={props.title !== undefined ? 'mt-0.5 text-sm opacity-85' : ''}>
            {props.children}
          </div>
        )}
      </div>
    </div>
  )
}
