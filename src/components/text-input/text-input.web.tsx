import type { ReactElement } from 'react'
import type { TextInputProps } from './types.js'
import { buildTextInputViewModel } from './view-model.js'

export function TextInputWeb(props: TextInputProps): ReactElement {
  const input = buildTextInputViewModel(props)
  const {
    tone: _tone,
    size: _size,
    fullWidth: _fullWidth,
    className: _className,
    'aria-label': nativeAriaLabel,
    ariaLabel,
    type,
    ...nativeProps
  } = props
  void _tone
  void _size
  void _fullWidth
  void _className

  return (
    <input
      {...nativeProps}
      type={type ?? 'text'}
      className={input.webClassName}
      aria-label={ariaLabel ?? nativeAriaLabel}
    />
  )
}
