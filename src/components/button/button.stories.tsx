import type { Meta, StoryObj } from '@storybook/react-vite'
import { ButtonWeb } from './button.web.js'
import type { ButtonSize, ButtonTone } from './types.js'

const meta = {
  title: 'Components/Button/Web',
  component: ButtonWeb,
  args: {
    children: 'apply',
    tone: 'info',
    size: 'sm',
  },
} satisfies Meta<typeof ButtonWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: ButtonTone[] = ['neutral', 'primary', 'info', 'success', 'warning', 'error', 'ghost']
const SIZES: ButtonSize[] = ['xs', 'sm', 'md', 'lg']

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      {TONES.map((tone) => (
        <ButtonWeb key={tone} {...args} tone={tone}>
          {tone}
        </ButtonWeb>
      ))}
    </div>
  ),
}

export const SizeMatrix: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      {SIZES.map((size) => (
        <ButtonWeb key={size} {...args} size={size}>
          size {size}
        </ButtonWeb>
      ))}
    </div>
  ),
}

export const OutlineAndCircle: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <ButtonWeb {...args} variant="outline">outline</ButtonWeb>
      <ButtonWeb {...args} tone="ghost">ghost</ButtonWeb>
      <ButtonWeb {...args} tone="ghost" shape="circle" size="sm" ariaLabel="Close">
        x
      </ButtonWeb>
    </div>
  ),
}

export const Disabled: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      {TONES.map((tone) => (
        <ButtonWeb key={tone} {...args} tone={tone} disabled>
          {tone}
        </ButtonWeb>
      ))}
    </div>
  ),
}

export const Mobile: Story = {
  render: (args) => (
    <div className="flex max-w-[390px] flex-col gap-2 rounded-xl border border-base-300/60 p-4">
      <ButtonWeb {...args} fullWidth tone="primary">
        primary — full width
      </ButtonWeb>
      <ButtonWeb {...args} fullWidth variant="outline" tone="info">
        outline — full width
      </ButtonWeb>
      <ButtonWeb {...args} fullWidth tone="ghost">
        ghost — full width
      </ButtonWeb>
    </div>
  ),
}
