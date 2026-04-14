import type { ReactElement } from 'react'
import type { TabsProps } from './types.js'
import { buildTabsViewModel } from './view-model.js'

export function TabsWeb(props: TabsProps): ReactElement {
  const vm = buildTabsViewModel(props)

  return (
    <div
      role="tablist"
      className={vm.containerClassName}
      aria-label={props.ariaLabel}
    >
      {props.tabs.map((tab) => {
        const isActive = tab.id === props.activeId
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            className={vm.tabClassName(isActive)}
            onClick={() => {
              if (!tab.disabled && !isActive) {
                props.onChange(tab.id)
              }
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
