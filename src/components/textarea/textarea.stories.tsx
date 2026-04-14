import type { Meta, StoryObj } from '@storybook/react-vite'
import { TextAreaWeb } from './textarea.web.js'
import type { TextAreaSize, TextAreaTone } from './types.js'

const meta = {
  title: 'Components/TextArea/Web',
  component: TextAreaWeb,
  args: {
    placeholder: 'Describe the change…',
    rows: 4,
    fullWidth: true,
  },
} satisfies Meta<typeof TextAreaWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: TextAreaTone[] = ['neutral', 'info', 'success', 'warning', 'error']

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {TONES.map((tone) => (
        <TextAreaWeb
          key={tone}
          {...args}
          tone={tone}
          defaultValue={`tone: ${tone}`}
        />
      ))}
    </div>
  ),
}

const SIZES: TextAreaSize[] = ['xs', 'sm', 'md', 'lg']

export const SizeMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {SIZES.map((size) => (
        <TextAreaWeb
          key={size}
          {...args}
          size={size}
          defaultValue={`size: ${size}`}
          rows={2}
        />
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'disabled' },
}

export const JsonEditor: Story = {
  args: {
    className: 'min-h-[160px] font-mono text-xs',
    defaultValue: '{\n  "merge": true\n}',
  },
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <TextAreaWeb {...args} defaultValue="mobile notes" />
    </div>
  ),
}
