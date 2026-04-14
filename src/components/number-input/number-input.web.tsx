import type { ReactElement } from 'react'
import { TextInputWeb } from '../text-input/text-input.web.js'
import type { NumberInputProps } from './types.js'

export function NumberInputWeb(props: NumberInputProps): ReactElement {
  const { min, max, step, ...rest } = props
  return (
    <TextInputWeb
      {...rest}
      type="number"
      min={min}
      max={max}
      step={step}
    />
  )
}
