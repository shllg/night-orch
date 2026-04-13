import type { Meta, StoryObj } from '@storybook/react-vite'
import { TextInputWeb } from './text-input.web.js'
import type { TextInputSize, TextInputTone } from './types.js'

const meta = {
  title: 'Components/TextInput/Web',
  component: TextInputWeb,
  args: {
    defaultValue: 'night-orch/night-orch',
    placeholder: 'owner/repo',
    size: 'sm',
    fullWidth: true,
  },
} satisfies Meta<typeof TextInputWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: TextInputTone[] = ['neutral', 'info', 'warning', 'error']

export const ToneStates: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {TONES.map((tone) => (
        <TextInputWeb
          key={tone}
          {...args}
          tone={tone}
          defaultValue={undefined}
          value={`tone: ${tone}`}
          onChange={() => {
            // Stories keep this controlled input read-only for matrix previews.
          }}
        />
      ))}
      <TextInputWeb
        {...args}
        tone="error"
        defaultValue={undefined}
        value="disabled"
        disabled
        onChange={() => {
          // Stories keep this controlled input read-only for matrix previews.
        }}
      />
    </div>
  ),
}

const SIZES: TextInputSize[] = ['xs', 'sm', 'md']

export const SizeMatrix: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      {SIZES.map((size) => (
        <TextInputWeb
          key={size}
          {...args}
          size={size}
          defaultValue={undefined}
          value={`size: ${size}`}
          onChange={() => {
            // Stories keep this controlled input read-only for matrix previews.
          }}
        />
      ))}
    </div>
  ),
}
