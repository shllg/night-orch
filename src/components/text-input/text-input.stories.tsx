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

const TONES: TextInputTone[] = ['neutral', 'info', 'success', 'warning', 'error']

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
          onChange={() => {}}
        />
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  render: (args) => (
    <div className="grid max-w-xl gap-2">
      <TextInputWeb
        {...args}
        defaultValue={undefined}
        value="disabled neutral"
        disabled
        onChange={() => {}}
      />
      <TextInputWeb
        {...args}
        tone="error"
        defaultValue={undefined}
        value="disabled error"
        disabled
        onChange={() => {}}
      />
    </div>
  ),
}

const SIZES: TextInputSize[] = ['xs', 'sm', 'md', 'lg']

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
          onChange={() => {}}
        />
      ))}
    </div>
  ),
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <TextInputWeb
        {...args}
        size="md"
        defaultValue={undefined}
        value="mobile sized input"
        onChange={() => {}}
      />
      <TextInputWeb
        {...args}
        tone="error"
        size="md"
        defaultValue={undefined}
        value="invalid entry"
        onChange={() => {}}
      />
    </div>
  ),
}
