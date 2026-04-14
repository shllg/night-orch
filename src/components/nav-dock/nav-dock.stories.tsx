import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { NavDockWeb } from './nav-dock.web.js'
import type { NavItem } from './types.js'

function CircleIcon({ label }: { label: string }): ReactElement {
  return (
    <span
      className="flex size-[1.1rem] items-center justify-center rounded-full bg-base-100/30 text-[10px] font-semibold uppercase"
      aria-hidden
    >
      {label[0]}
    </span>
  )
}

function buildItems(active: string, onClick: (id: string) => void): NavItem[] {
  return [
    { id: 'issues', label: 'issues', icon: <CircleIcon label="issues" /> },
    { id: 'stats', label: 'stats', icon: <CircleIcon label="stats" /> },
    { id: 'projects', label: 'projects', icon: <CircleIcon label="projects" /> },
    { id: 'settings', label: 'settings', icon: <CircleIcon label="settings" /> },
  ].map((item) => ({ ...item, isActive: item.id === active, onClick: () => { onClick(item.id) } }))
}

const meta = {
  title: 'Components/NavDock/Web',
  component: NavDockWeb,
  args: {
    items: [],
  },
} satisfies Meta<typeof NavDockWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState('issues')
    return (
      <div className="max-w-[390px] rounded-xl border border-base-300/60 p-4">
        <NavDockWeb items={buildItems(active, setActive)} ariaLabel="Dashboard pages" />
      </div>
    )
  },
}

export const WithSafeArea: Story = {
  render: () => {
    const [active, setActive] = useState('issues')
    return (
      <div className="max-w-[390px] rounded-xl border border-base-300/60 p-4">
        <NavDockWeb items={buildItems(active, setActive)} ariaLabel="Dashboard pages" safeArea />
      </div>
    )
  },
}
