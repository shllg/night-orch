import { Text } from 'ink'
import type { ReactElement } from 'react'
import type { ButtonProps } from './types.js'
import { buildButtonViewModel } from './view-model.js'

export function ButtonTui(props: ButtonProps): ReactElement {
  const button = buildButtonViewModel(props)
  const label = stringifyButtonChildren(props.children)
  const renderedLabel = button.shape === 'circle' ? `(${label})` : `[ ${label} ]`

  return (
    <Text color={props.disabled ? 'gray' : button.tuiColor} dimColor={props.disabled}>
      {renderedLabel}
    </Text>
  )
}

function stringifyButtonChildren(children: ButtonProps['children']): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  return 'button'
}
