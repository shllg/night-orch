import type { ReactElement } from 'react'
import type { CardProps } from './types.js'
import { buildCardViewModel } from './view-model.js'

export function CardWeb(props: CardProps): ReactElement {
  const card = buildCardViewModel(props)
  const hasHeader = Boolean(props.title) || Boolean(props.subtitle)
  const hasActions = isRenderableNode(props.actions)

  return (
    <article className={card.webContainerClass}>
      <div className={card.webBodyClass}>
        {hasHeader ? (
          <header className="space-y-1">
            {props.title ? <h2 className="card-title text-lg text-base-content">{props.title}</h2> : null}
            {props.subtitle ? <p className="text-sm text-base-content/70">{props.subtitle}</p> : null}
          </header>
        ) : null}
        {props.body ? <p className="text-sm text-base-content/85">{props.body}</p> : null}
        {props.children}
        {hasActions ? <footer className="card-actions justify-end">{props.actions}</footer> : null}
      </div>
    </article>
  )
}

function isRenderableNode(node: CardProps['actions']): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}
