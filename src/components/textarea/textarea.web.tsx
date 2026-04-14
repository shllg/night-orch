import type { ReactElement } from 'react'
import type { TextAreaProps } from './types.js'
import { buildTextAreaViewModel } from './view-model.js'

export function TextAreaWeb(props: TextAreaProps): ReactElement {
  const vm = buildTextAreaViewModel(props)
  const {
    tone: _tone,
    size: _size,
    fullWidth: _fullWidth,
    ariaLabel,
    'aria-label': nativeAriaLabel,
    ...nativeProps
  } = props
  void _tone
  void _size
  void _fullWidth

  return (
    <textarea
      {...nativeProps}
      className={vm.webClassName}
      aria-label={ariaLabel ?? nativeAriaLabel}
    />
  )
}
