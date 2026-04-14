import type { Meta, StoryObj } from '@storybook/react-vite'
import { NumberInputWeb } from './number-input.web.js'

const meta = {
  title: 'Components/NumberInput/Web',
  component: NumberInputWeb,
  args: {
    defaultValue: 3,
    size: 'sm',
    min: 0,
    max: 10,
    step: 1,
  },
} satisfies Meta<typeof NumberInputWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithBounds: Story = {
  args: { min: 0, max: 100, step: 5, defaultValue: 25 },
}

export const ErrorState: Story = {
  args: { tone: 'error', defaultValue: -1 },
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <NumberInputWeb {...args} fullWidth />
    </div>
  ),
}
