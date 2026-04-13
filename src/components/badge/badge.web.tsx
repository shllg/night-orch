import type { ReactElement } from 'react'
import type { BadgeProps } from './types.js'
import { buildBadgeViewModel } from './view-model.js'

export function BadgeWeb(props: BadgeProps): ReactElement {
  const badge = buildBadgeViewModel(props)

  return <span className={badge.webClassName}>{props.children}</span>
}
