import { type ReactElement, useCallback, useEffect, useId } from 'react'
import { ButtonWeb } from '../button/button.web.js'
import type { ModalProps } from './types.js'

const DEFAULT_WIDTH_CLASS = 'max-w-xl'

interface ModalDismissState {
  canRequestClose: boolean
  shouldCloseOnBackdropClick: boolean
}

interface ModalKeyEvent {
  key: string
  preventDefault: () => void
}

interface GlobalEventTargetLike {
  addEventListener: (eventName: string, listener: (event: unknown) => void) => void
  removeEventListener: (eventName: string, listener: (event: unknown) => void) => void
}

export function ModalWeb(props: ModalProps): ReactElement | null {
  const titleId = useId()
  const descriptionId = useId()
  const dismissState = resolveModalDismissState(props)

  const widthClassName = props.widthClassName ?? DEFAULT_WIDTH_CLASS
  const hasActions = isRenderableNode(props.actions)
  const closeButtonLabel = props.closeButtonLabel ?? 'Close dialog'
  const ariaLabel = resolveAriaLabel(props)
  const labelledBy = props.ariaLabel !== undefined ? undefined : props.title ? titleId : undefined

  const requestClose = useCallback((): void => {
    requestModalClose(dismissState.canRequestClose, props.onClose)
  }, [dismissState.canRequestClose, props.onClose])

  useEffect(() => {
    if (!props.open || !dismissState.canRequestClose) {
      return
    }

    const eventTarget = getGlobalEventTarget()
    if (eventTarget === null) {
      return
    }

    const onKeyDown = (event: unknown): void => {
      if (!isModalKeyEvent(event)) {
        return
      }
      handleModalEscapeKey(event, dismissState.canRequestClose, props.onClose)
    }

    eventTarget.addEventListener('keydown', onKeyDown)
    return () => {
      eventTarget.removeEventListener('keydown', onKeyDown)
    }
  }, [props.open, dismissState.canRequestClose, props.onClose])

  if (!props.open) {
    return null
  }

  return (
    <div
      className="modal modal-open bg-slate-950/78 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={props.description ? descriptionId : undefined}
      aria-label={ariaLabel}
    >
      <section
        className={`modal-box relative w-full ${widthClassName} rounded-box border border-base-300/80 bg-base-100/95 p-5 shadow-2xl`}
      >
        {dismissState.canRequestClose ? (
          <ButtonWeb
            type="button"
            tone="ghost"
            size="sm"
            shape="circle"
            className="absolute right-3 top-3"
            onClick={requestClose}
            ariaLabel={closeButtonLabel}
          >
            x
          </ButtonWeb>
        ) : null}

        {props.title ? <h2 id={titleId} className="pr-10 text-lg font-semibold">{props.title}</h2> : null}
        {props.description ? <p id={descriptionId} className="mt-1 text-sm text-base-content/75">{props.description}</p> : null}
        {props.children}
        {hasActions ? <footer className="mt-5 flex justify-end gap-2">{props.actions}</footer> : null}
      </section>

      {dismissState.shouldCloseOnBackdropClick ? (
        <button type="button" className="modal-backdrop" aria-label={closeButtonLabel} onClick={requestClose}>
          close
        </button>
      ) : (
        <div className="modal-backdrop cursor-default" aria-hidden="true" />
      )}
    </div>
  )
}

function isRenderableNode(node: ModalProps['actions']): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

export function resolveModalDismissState(
  props: Pick<ModalProps, 'onClose' | 'blocking' | 'closeOnBackdropClick'>,
): ModalDismissState {
  const canRequestClose = typeof props.onClose === 'function' && !props.blocking
  const shouldCloseOnBackdropClick = canRequestClose && (props.closeOnBackdropClick ?? true)
  return {
    canRequestClose,
    shouldCloseOnBackdropClick,
  }
}

export function requestModalClose(
  canRequestClose: boolean,
  onClose: ModalProps['onClose'],
): boolean {
  if (!canRequestClose || onClose === undefined) {
    return false
  }
  onClose()
  return true
}

export function handleModalEscapeKey(
  event: ModalKeyEvent,
  canRequestClose: boolean,
  onClose: ModalProps['onClose'],
): boolean {
  if (!canRequestClose || event.key !== 'Escape') {
    return false
  }
  event.preventDefault()
  return requestModalClose(canRequestClose, onClose)
}

function resolveAriaLabel(props: Pick<ModalProps, 'title' | 'ariaLabel'>): string | undefined {
  if (props.ariaLabel !== undefined) {
    return props.ariaLabel
  }
  if (props.title === undefined) {
    return 'Modal dialog'
  }
  return undefined
}

function isModalKeyEvent(event: unknown): event is ModalKeyEvent {
  if (typeof event !== 'object' || event === null) {
    return false
  }

  const candidate = event as { key?: unknown; preventDefault?: unknown }
  return typeof candidate.key === 'string' && typeof candidate.preventDefault === 'function'
}

function getGlobalEventTarget(): GlobalEventTargetLike | null {
  const candidate = globalThis as Partial<GlobalEventTargetLike>
  if (typeof candidate.addEventListener !== 'function') {
    return null
  }
  if (typeof candidate.removeEventListener !== 'function') {
    return null
  }
  return candidate as GlobalEventTargetLike
}
