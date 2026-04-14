import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertWeb } from './alert.web.js'
import type { AlertTone } from './types.js'

const meta = {
  title: 'Components/Alert/Web',
  component: AlertWeb,
  args: {
    title: 'Heads up',
    children: 'This is the alert body.',
  },
} satisfies Meta<typeof AlertWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: AlertTone[] = ['neutral', 'info', 'success', 'warning', 'error']

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-3">
      {TONES.map((tone) => (
        <AlertWeb key={tone} {...args} tone={tone} title={tone} />
      ))}
    </div>
  ),
}

export const EmptyState: Story = {
  args: {
    role: 'status',
    title: undefined,
    children: 'No runs yet. Start one to see activity here.',
  },
}

export const Error: Story = {
  args: {
    role: 'alert',
    tone: 'error',
    title: 'Push failed',
    children: 'Run 42 could not push its branch — check logs.',
  },
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <AlertWeb {...args} tone="info" />
      <AlertWeb tone="error" role="alert" title="Error" children="Something failed." />
    </div>
  ),
}
