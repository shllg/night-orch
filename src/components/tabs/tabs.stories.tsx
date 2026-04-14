import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { TabsWeb } from './tabs.web.js'
import type { TabsVariant } from './types.js'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
  { id: 'settings', label: 'Settings' },
]

const meta = {
  title: 'Components/Tabs/Web',
  component: TabsWeb,
  args: {
    tabs: TABS,
    activeId: 'overview',
    onChange: () => {},
  },
} satisfies Meta<typeof TabsWeb>

export default meta
type Story = StoryObj<typeof meta>

function ControlledExample({ variant }: { variant?: TabsVariant }) {
  const [active, setActive] = useState('overview')
  return (
    <div className="space-y-3">
      <TabsWeb
        tabs={TABS}
        activeId={active}
        onChange={setActive}
        variant={variant}
        ariaLabel="Dashboard sections"
      />
      <p className="text-sm text-base-content/70">Active tab: <code>{active}</code></p>
    </div>
  )
}

export const Default: Story = {
  render: () => <ControlledExample />,
}

export const Box: Story = {
  render: () => <ControlledExample variant="box" />,
}

export const Lift: Story = {
  render: () => <ControlledExample variant="lift" />,
}

export const Border: Story = {
  render: () => <ControlledExample variant="border" />,
}

export const Disabled: Story = {
  render: () => {
    const [active, setActive] = useState('overview')
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'locked', label: 'Locked', disabled: true },
      { id: 'runs', label: 'Runs' },
    ]
    return <TabsWeb tabs={tabs} activeId={active} onChange={setActive} variant="box" />
  },
}

export const Mobile: Story = {
  render: () => {
    const [active, setActive] = useState('overview')
    return (
      <div className="max-w-[390px] rounded-xl border border-base-300/60 p-4">
        <TabsWeb tabs={TABS} activeId={active} onChange={setActive} variant="box" size="sm" />
      </div>
    )
  },
}
