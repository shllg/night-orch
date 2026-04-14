import type { ReactElement } from 'react'
import type { LogLineProps } from './types.js'
import { buildLogLineViewModel } from './view-model.js'

export function LogLineWeb(props: LogLineProps): ReactElement {
  const vm = buildLogLineViewModel(props)
  return (
    <div className={vm.containerClassName}>
      <span className="text-base-content/55">{props.timestamp}</span>
      <span className={vm.sourceClassName}>{vm.sourceLabel}</span>
      <span className="min-w-0 break-words text-base-content/85">{props.message}</span>
    </div>
  )
}
