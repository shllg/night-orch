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

const TONES: ButtonTone[] = ['neutral', 'primary', 'info', 'error', 'ghost']
const SIZES: ButtonSize[] = ['xs', 'sm', 'md']

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
