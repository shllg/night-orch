import type { TextInputProps, TextInputSize, TextInputTone, TextInputViewModel } from './types.js'

const SIZE_WEB_CLASS: Record<TextInputSize, string | null> = {
  xs: 'input-xs',
  sm: 'input-sm',
  md: null,
  lg: 'input-lg',
}

const TONE_WEB_CLASS: Record<TextInputTone, string | null> = {
  neutral: null,
  info: 'input-info',
  success: 'input-success',
  warning: 'input-warning',
  error: 'input-error',
}

export function buildTextInputViewModel(props: TextInputProps): TextInputViewModel {
  const tone = props.tone ?? 'neutral'
  const size = props.size ?? 'md'
  const classes = ['input', TONE_WEB_CLASS[tone], SIZE_WEB_CLASS[size]]

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
