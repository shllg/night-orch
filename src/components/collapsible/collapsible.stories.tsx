import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { CollapsibleWeb } from './collapsible.web.js'

const meta = {
  title: 'Components/Collapsible/Web',
  component: CollapsibleWeb,
  args: {
    title: 'Run details',
    children: 'Body content goes here — logs, metadata, anything.',
  },
} satisfies Meta<typeof CollapsibleWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const DefaultOpen: Story = {
  args: { defaultOpen: true },
}

export const PlusIcon: Story = {
  args: { icon: 'plus' },
}

export const Controlled: Story = {
  render: (args) => {
    const [open, setOpen] = useState(false)
    return (
      <div className="space-y-3">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => { setOpen((v) => !v) }}
        >
          Toggle externally ({open ? 'open' : 'closed'})
        </button>
        <CollapsibleWeb {...args} open={open} onOpenChange={setOpen} />
      </div>
    )
  },
}

export const Mobile: Story = {
  render: (args) => (
    <div className="grid max-w-[390px] gap-2 rounded-xl border border-base-300/60 p-4">
      <CollapsibleWeb {...args} />
      <CollapsibleWeb {...args} icon="plus" title="Another section" />
    </div>
  ),
}
