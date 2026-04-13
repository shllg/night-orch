import type { ReactElement } from 'react'
import type { BadgeProps } from './types.js'
import { buildBadgeViewModel } from './view-model.js'

export function BadgeWeb(props: BadgeProps): ReactElement {
  const badge = buildBadgeViewModel(props)
  const {
    children,
    tone: _tone,
    variant: _variant,
    size: _size,
    capitalize: _capitalize,
    className: _className,
    ...nativeProps
  } = props
  void _tone
  void _variant
  void _size
  void _capitalize
  void _className

  return <span {...nativeProps} className={badge.webClassName}>{children}</span>
}
