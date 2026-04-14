import type { TabsProps, TabsSize, TabsVariant, TabsViewModel } from './types.js'

const VARIANT_CLASS: Record<TabsVariant, string | null> = {
  default: null,
  box: 'tabs-box',
  lift: 'tabs-lift',
  border: 'tabs-border',
}

const SIZE_CLASS: Record<TabsSize, string | null> = {
  xs: 'tabs-xs',
  sm: 'tabs-sm',
  md: null,
  lg: 'tabs-lg',
}

export function buildTabsViewModel(props: TabsProps): TabsViewModel {
  const variant = props.variant ?? 'default'
  const size = props.size ?? 'md'
  const containerTokens = ['tabs', VARIANT_CLASS[variant], SIZE_CLASS[size]]
  if (props.className !== undefined && props.className.trim().length > 0) {
    containerTokens.push(props.className.trim())
  }
  const containerClassName = containerTokens
    .filter((token): token is string => token !== null)
    .join(' ')

  return {
    variant,
    size,
    containerClassName,
    tabClassName(isActive: boolean): string {
      return isActive ? 'tab tab-active' : 'tab'
    },
  }
}
