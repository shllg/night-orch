import type { Meta, StoryObj } from '@storybook/react-vite'
import { LogLineWeb } from './log-line.web.js'

const meta = {
  title: 'Components/LogLine/Web',
  component: LogLineWeb,
  args: {
    timestamp: '14:03:22.104',
    source: 'agent',
    role: 'claude',
    message: 'Applied patch to src/loop/engine.ts',
  },
} satisfies Meta<typeof LogLineWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const System: Story = {
  args: { source: 'system', role: undefined, message: 'Phase complete: verify' },
}

export const StreamSample: Story = {
  render: () => (
    <div className="max-w-3xl rounded-box border border-base-300/70 bg-base-100/80 p-3">
      <LogLineWeb timestamp="14:03:20.001" source="system" message="phase_start: plan" />
      <LogLineWeb timestamp="14:03:21.400" source="agent" role="claude" message="Reading issue body and discussing approach." />
      <LogLineWeb timestamp="14:03:22.104" source="agent" role="claude" message="Applied patch to src/loop/engine.ts" />
      <LogLineWeb timestamp="14:03:22.552" source="system" message="phase_complete: plan (1.55s)" />
      <LogLineWeb timestamp="14:03:23.100" source="agent" role="codex" message="Running npm test…" />
    </div>
  ),
}

export const Mobile: Story = {
  render: () => (
    <div className="max-w-[390px] rounded-box border border-base-300/70 bg-base-100/80 p-3">
      <LogLineWeb timestamp="14:03:20" source="system" message="phase_start: plan" />
      <LogLineWeb timestamp="14:03:21" source="agent" role="claude" message="Very long message that will wrap onto multiple lines on narrow viewports." />
    </div>
  ),
}
