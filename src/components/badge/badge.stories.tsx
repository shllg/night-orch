import type { Meta, StoryObj } from '@storybook/react-vite'
import { BadgeWeb } from './badge.web.js'
import type { BadgeSize, BadgeTone } from './types.js'

const meta = {
  title: 'Components/Badge/Web',
  component: BadgeWeb,
  args: {
    children: 'running',
    tone: 'info',
    size: 'sm',
  },
} satisfies Meta<typeof BadgeWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const TONES: BadgeTone[] = [
  'neutral',
  'primary',
  'secondary',
  'accent',
  'info',
  'success',
  'warning',
  'error',
  'ghost',
]

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      {TONES.map((tone) => (
        <BadgeWeb key={tone} {...args} tone={tone}>
          {tone}
        </BadgeWeb>
      ))}
    </div>
  ),
}

const SIZES: BadgeSize[] = ['xs', 'sm', 'md']

export const SizeAndVariantMatrix: Story = {
  render: (args) => (
    <div className="space-y-3">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-2">
          <BadgeWeb {...args} size={size} variant="solid" tone="info">
            solid {size}
          </BadgeWeb>
          <BadgeWeb {...args} size={size} variant="outline" tone="warning">
            outline {size}
          </BadgeWeb>
          <BadgeWeb {...args} size={size} tone="error" className="orch-working-pulse">
            alert {size}
          </BadgeWeb>
        </div>
      ))}
    </div>
  ),
}
