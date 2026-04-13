import type { ReactElement } from 'react'
import type { ButtonProps } from './types.js'
import { buildButtonViewModel } from './view-model.js'

export function ButtonWeb(props: ButtonProps): ReactElement {
  const button = buildButtonViewModel(props)
  const {
    children,
    tone: _tone,
    variant: _variant,
    size: _size,
    shape: _shape,
    fullWidth: _fullWidth,
    'aria-label': nativeAriaLabel,
    ariaLabel,
    ...nativeProps
  } = props
  void _tone
  void _variant
  void _size
  void _shape
  void _fullWidth

  return (
    <button
      {...nativeProps}
      type={props.type ?? 'button'}
      className={button.webClassName}
      aria-label={ariaLabel ?? nativeAriaLabel}
    >
      {children}
    </button>
  )
}
