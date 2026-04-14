import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { NavMenuWeb } from './nav-menu.web.js'
import type { NavItem } from './types.js'

function CircleIcon({ label }: { label: string }): ReactElement {
  return (
    <span
      className="flex size-5 items-center justify-center rounded-full bg-base-100/30 text-[10px] font-semibold uppercase"
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
  title: 'Components/NavMenu/Web',
  component: NavMenuWeb,
  args: {
    items: [],
  },
} satisfies Meta<typeof NavMenuWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Sidebar: Story = {
  render: () => {
    const [active, setActive] = useState('issues')
    return (
      <div className="w-56 rounded-xl border border-base-300/60 bg-base-200/45 px-3 py-4">
        <NavMenuWeb items={buildItems(active, setActive)} ariaLabel="Dashboard pages" />
      </div>
    )
  },
}

export const Compact: Story = {
  render: () => {
    const [active, setActive] = useState('issues')
    return (
      <div className="w-20 rounded-xl border border-base-300/60 bg-base-200/45 px-2 py-4">
        <NavMenuWeb items={buildItems(active, setActive)} ariaLabel="Dashboard pages" compact />
      </div>
    )
  },
}
