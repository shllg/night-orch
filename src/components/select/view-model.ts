import type { SelectProps, SelectSize, SelectTone, SelectViewModel } from './types.js'

const TONE_WEB_CLASS: Record<SelectTone, string | null> = {
  neutral: null,
  primary: 'select-primary',
  info: 'select-info',
  success: 'select-success',
  warning: 'select-warning',
  error: 'select-error',
}

const SIZE_WEB_CLASS: Record<SelectSize, string | null> = {
  xs: 'select-xs',
  sm: 'select-sm',
  md: null,
  lg: 'select-lg',
}

export function buildSelectViewModel(props: SelectProps): SelectViewModel {
  const tone = props.tone ?? 'neutral'
  const size = props.size ?? 'md'
  const classes = ['select', TONE_WEB_CLASS[tone], SIZE_WEB_CLASS[size]]

  if (props.fullWidth) {
    classes.push('w-full')
  }
  if (props.className !== undefined && props.className.trim().length > 0) {
    classes.push(props.className.trim())
  }

  return {
    tone,
    size,
    webClassName: classes.filter((token): token is string => token !== null).join(' '),
  }
}
