import type { Meta, StoryObj } from '@storybook/react-vite'
import { CardWeb } from './card.web.js'
import type { CardTone } from './types.js'

const meta = {
  title: 'Components/Card/Web',
  component: CardWeb,
  args: {
    title: 'Run Summary',
    subtitle: 'night-orch/night-orch#110',
    body: 'Verification passed and the run is ready to merge.',
    tone: 'neutral',
  },
} satisfies Meta<typeof CardWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithActions: Story = {
  args: {
    actions: (
      <>
        <button type="button" className="btn btn-ghost btn-sm">
          Re-run
        </button>
        <button type="button" className="btn btn-primary btn-sm">
          Open PR
        </button>
      </>
    ),
  },
}

const CARD_TONES: CardTone[] = ['neutral', 'info', 'success', 'warning', 'error']

export const ToneMatrix: Story = {
  render: (args) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {CARD_TONES.map((tone) => (
        <CardWeb
          key={tone}
          {...args}
          title={`${tone.toUpperCase()} card`}
          subtitle="Shared card style for dashboards and lists"
          tone={tone}
        />
      ))}
    </div>
  ),
}
