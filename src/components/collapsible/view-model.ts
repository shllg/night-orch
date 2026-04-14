import type { CollapsibleIcon, CollapsibleProps, CollapsibleViewModel } from './types.js'

const ICON_CLASS: Record<CollapsibleIcon, string> = {
  arrow: 'collapse-arrow',
  plus: 'collapse-plus',
}

export function buildCollapsibleViewModel(props: CollapsibleProps): CollapsibleViewModel {
  const icon = props.icon ?? 'arrow'
  const classes = ['collapse', ICON_CLASS[icon], 'border', 'border-base-300/60', 'bg-base-200/40']

  if (props.className !== undefined && props.className.trim().length > 0) {
    classes.push(props.className.trim())
  }

  return {
    icon,
    containerClassName: classes.join(' '),
  }
}
