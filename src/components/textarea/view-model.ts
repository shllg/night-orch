import type { TextAreaProps, TextAreaSize, TextAreaTone, TextAreaViewModel } from './types.js'

const TONE_WEB_CLASS: Record<TextAreaTone, string | null> = {
  neutral: null,
  info: 'textarea-info',
  success: 'textarea-success',
  warning: 'textarea-warning',
  error: 'textarea-error',
}

const SIZE_WEB_CLASS: Record<TextAreaSize, string | null> = {
  xs: 'textarea-xs',
  sm: 'textarea-sm',
  md: null,
  lg: 'textarea-lg',
}

export function buildTextAreaViewModel(props: TextAreaProps): TextAreaViewModel {
  const tone = props.tone ?? 'neutral'
  const size = props.size ?? 'md'
  const classes = ['textarea', TONE_WEB_CLASS[tone], SIZE_WEB_CLASS[size]]

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
