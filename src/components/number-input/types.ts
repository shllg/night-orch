import type { TextInputProps } from '../text-input/types.js'

/**
 * NumberInput is a thin wrapper over TextInput with `type="number"` locked
 * and `min`/`max`/`step` typed as numbers instead of `number | string`.
 */
export interface NumberInputProps extends Omit<TextInputProps, 'type' | 'min' | 'max' | 'step'> {
  min?: number
  max?: number
  step?: number
}
