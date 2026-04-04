import { Box, Text } from 'ink'
import { Fragment, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { CardProps, CardTuiColor } from './types.js'
import { buildCardViewModel } from './view-model.js'

export function CardTui(props: CardProps): ReactElement {
  const card = buildCardViewModel(props)
  const renderedChildren = normalizeNodeForTui(props.children)
  const renderedActions = normalizeNodeForTui(props.actions, 'gray')
  const hasHeader = Boolean(props.title) || Boolean(props.subtitle)
  const hasChildren = isRenderableNode(renderedChildren)
  const hasActions = isRenderableNode(renderedActions)

  return (
    <Box
      borderStyle="round"
      borderColor={card.tuiBorderColor}
      flexDirection="column"
      paddingX={card.tuiPaddingX}
      paddingY={card.tuiPaddingY}
    >
      {hasHeader ? (
        <Box flexDirection="column" marginBottom={props.body || hasChildren || hasActions ? 1 : 0}>
          {props.title ? (
            <Text bold color={card.tuiTitleColor}>
              {props.title}
            </Text>
          ) : null}
          {props.subtitle ? <Text color="gray">{props.subtitle}</Text> : null}
        </Box>
      ) : null}
      {props.body ? <Text>{props.body}</Text> : null}
      {hasChildren ? <Box marginTop={props.body ? 1 : 0}>{renderedChildren}</Box> : null}
      {hasActions ? <Box justifyContent="flex-end" marginTop={1}>{renderedActions}</Box> : null}
    </Box>
  )
}

function isRenderableNode(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

function normalizeNodeForTui(node: ReactNode, textColor?: CardTuiColor): ReactNode {
  if (!isRenderableNode(node)) {
    return null
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return <Text color={textColor}>{String(node)}</Text>
  }

  if (Array.isArray(node)) {
    const normalized: ReactNode[] = []
    for (const [index, child] of node.entries()) {
      const normalizedChild = normalizeNodeForTui(child, textColor)
      if (!isRenderableNode(normalizedChild)) {
        continue
      }

      normalized.push(<Fragment key={String(index)}>{normalizedChild}</Fragment>)
    }
    return normalized.length > 0 ? normalized : null
  }

  if (isValidElement(node) && node.type === Fragment) {
    const fragmentChildren = (node.props as { children?: ReactNode }).children
    return normalizeNodeForTui(fragmentChildren, textColor)
  }

  return node
}
