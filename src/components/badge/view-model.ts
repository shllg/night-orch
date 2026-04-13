import type { BadgeProps, BadgeSize, BadgeTone, BadgeViewModel } from './types.js'

const SIZE_WEB_CLASS: Record<BadgeSize, string | null> = {
  xs: 'badge-xs',
  sm: 'badge-sm',
  md: null,
}

function toneClass(tone: BadgeTone | undefined): string | null {
  if (tone === undefined) {
    return null
  }

  return `badge-${tone}`
}

export function buildBadgeViewModel(props: BadgeProps): BadgeViewModel {
  const variant = props.variant ?? 'solid'
  const size = props.size ?? 'md'
  const classes = ['badge', toneClass(props.tone), SIZE_WEB_CLASS[size]]

  if (variant === 'outline') {
    classes.push('badge-outline')
  }
  if (props.capitalize) {
    classes.push('capitalize')
  }
  if (props.className !== undefined && props.className.trim().length > 0) {
    classes.push(props.className.trim())
  }

  return {
    tone: props.tone,
    variant,
    size,
    webClassName: classes.filter((token): token is string => token !== null).join(' '),
  }
}
