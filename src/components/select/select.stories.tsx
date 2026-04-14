import type { Meta, StoryObj } from '@storybook/react-vite'
import { SelectWeb } from './select.web.js'
import type { SelectSize, SelectTone } from './types.js'

const options = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
]

const meta = {
  title: 'Components/Select/Web',
  component: SelectWeb,
  args: {
    options,
    defaultValue: 'claude',
    size: 'sm',
    fullWidth: true,
  },
} satisfies Meta<typeof SelectWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: SelectTone[] = ['neutral', 'primary', 'info', 'success', 'warning', 'error']

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {TONES.map((tone) => (
        <SelectWeb key={tone} {...args} tone={tone} />
      ))}
    </div>
  ),
}

const SIZES: SelectSize[] = ['xs', 'sm', 'md', 'lg']

export const SizeMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {SIZES.map((size) => (
        <SelectWeb key={size} {...args} size={size} />
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <SelectWeb {...args} />
      <SelectWeb {...args} tone="error" />
    </div>
  ),
}
