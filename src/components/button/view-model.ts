import type {
  ButtonProps,
  ButtonShape,
  ButtonSize,
  ButtonTone,
  ButtonTuiColor,
  ButtonViewModel,
} from './types.js'

const TONE_WEB_CLASS: Record<ButtonTone, string> = {
  neutral: 'btn-neutral',
  primary: 'btn-primary',
  info: 'btn-info',
  error: 'btn-error',
  ghost: 'btn-ghost',
}

const SIZE_WEB_CLASS: Record<ButtonSize, string | null> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: null,
}

const SHAPE_WEB_CLASS: Record<ButtonShape, string | null> = {
  default: null,
  circle: 'btn-circle',
}

const TONE_TUI_COLOR: Record<ButtonTone, ButtonTuiColor> = {
  neutral: 'white',
  primary: 'blue',
  info: 'cyan',
  error: 'red',
  ghost: 'gray',
}

export function buildButtonViewModel(props: ButtonProps): ButtonViewModel {
  const tone = props.tone ?? 'neutral'
  const variant = props.variant ?? 'solid'
  const size = props.size ?? 'md'
  const shape = props.shape ?? 'default'
  const classes = [
    'btn',
    TONE_WEB_CLASS[tone],
    SIZE_WEB_CLASS[size],
    SHAPE_WEB_CLASS[shape],
  ]

  if (variant === 'outline' && tone !== 'ghost') {
    classes.push('btn-outline')
  }
  if (props.fullWidth) {
    classes.push('w-full')
  }
  if (props.className !== undefined && props.className.trim().length > 0) {
    classes.push(props.className.trim())
  }

  return {
    tone,
    variant,
    size,
    shape,
    webClassName: classes.filter((token): token is string => token !== null).join(' '),
    tuiColor: TONE_TUI_COLOR[tone],
  }
}
