import type { CardProps, CardTone, CardTuiColor, CardViewModel } from './types.js'

const WEB_TONE_CLASS: Record<CardTone, string> = {
  neutral: 'border border-base-300/60 bg-base-200/60 backdrop-blur',
  info: 'border border-info/40 bg-info/10 backdrop-blur',
  success: 'border border-success/40 bg-success/10 backdrop-blur',
  warning: 'border border-warning/40 bg-warning/10 backdrop-blur',
  error: 'border border-error/40 bg-error/10 backdrop-blur',
}

const TUI_BORDER_COLOR: Record<CardTone, CardTuiColor> = {
  neutral: 'gray',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
}

const TUI_TITLE_COLOR: Record<CardTone, CardTuiColor> = {
  neutral: 'white',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
}

export function buildCardViewModel(props: CardProps): CardViewModel {
  const tone = props.tone ?? 'neutral'
  const compact = props.compact ?? false

  return {
    tone,
    webContainerClass: `card shadow-panel ${WEB_TONE_CLASS[tone]}`,
    webBodyClass: compact ? 'card-body gap-2 p-3' : 'card-body gap-3 p-4 sm:p-5',
    tuiBorderColor: TUI_BORDER_COLOR[tone],
    tuiTitleColor: TUI_TITLE_COLOR[tone],
    tuiPaddingX: compact ? 1 : 2,
    tuiPaddingY: compact ? 0 : 1,
  }
}
