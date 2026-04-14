import type { ChangeEvent, ReactElement } from 'react'
import type { SelectProps } from './types.js'
import { buildSelectViewModel } from './view-model.js'

export function SelectWeb(props: SelectProps): ReactElement {
  const vm = buildSelectViewModel(props)
  const {
    tone: _tone,
    size: _size,
    fullWidth: _fullWidth,
    options,
    children,
    onSelect,
    onChange,
    ariaLabel,
    'aria-label': nativeAriaLabel,
    ...nativeProps
  } = props
  void _tone
  void _size
  void _fullWidth

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange?.(event)
    if (onSelect !== undefined) {
      const target = event.currentTarget as unknown as { value: string }
      onSelect(target.value)
    }
  }

  return (
    <select
      {...nativeProps}
      className={vm.webClassName}
      onChange={handleChange}
      aria-label={ariaLabel ?? nativeAriaLabel}
    >
      {options?.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
      {children}
    </select>
  )
}
