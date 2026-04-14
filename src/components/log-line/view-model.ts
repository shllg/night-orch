import type { LogLineProps, LogLineSource, LogLineViewModel } from './types.js'

const SOURCE_CLASS: Record<LogLineSource, string> = {
  system: 'text-secondary',
  agent: 'text-info',
}

export function buildLogLineViewModel(props: LogLineProps): LogLineViewModel {
  const tokens = [
    'grid',
    'grid-cols-[auto_auto_1fr]',
    'gap-x-3',
    'gap-y-1',
    'border-b',
    'border-base-300/30',
    'py-1',
    'last:border-b-0',
    'font-mono',
    'text-xs',
  ]
  if (props.className !== undefined && props.className.trim().length > 0) {
    tokens.push(props.className.trim())
  }

  const sourceLabel = props.source === 'system' ? 'system' : props.role ?? 'agent'

  return {
    containerClassName: tokens.join(' '),
    sourceClassName: SOURCE_CLASS[props.source],
    sourceLabel,
  }
}
