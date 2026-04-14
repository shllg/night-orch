import type { AlertProps, AlertTone, AlertViewModel } from './types.js'

const TONE_WEB_CLASS: Record<AlertTone, string | null> = {
  neutral: null,
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  error: 'alert-error',
}

export function buildAlertViewModel(props: AlertProps): AlertViewModel {
  const tone = props.tone ?? 'neutral'
  const classes = ['alert', TONE_WEB_CLASS[tone]]

  if (props.className !== undefined && props.className.trim().length > 0) {
    classes.push(props.className.trim())
  }

  return {
    tone,
    webClassName: classes.filter((token): token is string => token !== null).join(' '),
  }
}
