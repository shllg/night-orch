import type { ReactElement, SyntheticEvent } from 'react'
import { useState } from 'react'
import type { CollapsibleProps } from './types.js'
import { buildCollapsibleViewModel } from './view-model.js'

export function CollapsibleWeb(props: CollapsibleProps): ReactElement {
  const vm = buildCollapsibleViewModel(props)
  const isControlled = props.open !== undefined
  const [internalOpen, setInternalOpen] = useState<boolean>(props.defaultOpen ?? false)
  const open = isControlled ? Boolean(props.open) : internalOpen

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const target = event.currentTarget as unknown as { open: boolean }
    const next = target.open
    if (!isControlled) {
      setInternalOpen(next)
    }
    if (next !== open) {
      props.onOpenChange?.(next)
    }
  }

  return (
    <details
      className={vm.containerClassName}
      open={open}
      onToggle={handleToggle}
    >
      <summary className="collapse-title text-sm font-medium">{props.title}</summary>
      <div className="collapse-content text-sm">{props.children}</div>
    </details>
  )
}
