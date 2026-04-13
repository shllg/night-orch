import { type ReactElement, useEffect, useRef } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ErrorBlock } from './ErrorBlock.js'

const SAMPLE_ERROR = [
  'Error: verify command failed',
  'at runVerify (src/loop/verifier.ts:143:11)',
  'at executeLoop (src/loop/engine.ts:302:9)',
  'at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  'AssertionError: expected 200 to equal 201',
  '    at test/workflow.spec.ts:84:17',
  '    at async Promise.all (index 0)',
  'Build failed with exit code 1',
].join('\n')

const meta = {
  title: 'Web/ErrorBlock',
  component: ErrorBlock,
  args: {
    title: 'Run error',
    error: SAMPLE_ERROR,
    collapsedLineCount: 4,
    collapsedCharCount: 600,
  },
} satisfies Meta<typeof ErrorBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Collapsed: Story = {}

export const Expanded: Story = {
  args: {
    defaultExpanded: true,
  },
}

export const CopiedState: Story = {
  render: (args) => <CopyFeedbackPreview {...args} mode="copied" />,
}

export const CopyFailureState: Story = {
  render: (args) => <CopyFeedbackPreview {...args} mode="failed" />,
}

type CopyFeedbackPreviewProps = React.ComponentProps<typeof ErrorBlock> & {
  mode: 'copied' | 'failed'
}

function CopyFeedbackPreview({ mode, ...args }: CopyFeedbackPreviewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: () => (mode === 'copied' ? Promise.resolve() : Promise.reject(new Error('copy failed'))),
      },
      configurable: true,
    })
    if (mode === 'failed') {
      Object.defineProperty(document, 'execCommand', {
        value: () => false,
        configurable: true,
      })
    }

    const copyButton = containerRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')
    copyButton?.click()

    return () => {
      restoreProperty(window.navigator, 'clipboard', navigatorDescriptor)
      restoreProperty(document, 'execCommand', execCommandDescriptor)
    }
  }, [mode])

  return (
    <div ref={containerRef}>
      <ErrorBlock {...args} />
    </div>
  )
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
    return
  }
  Reflect.deleteProperty(target, key)
}
