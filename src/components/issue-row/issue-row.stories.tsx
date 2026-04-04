import type { Meta, StoryObj } from '@storybook/react-vite'
import { IssueRowWeb } from './issue-row.web.js'
import type { IssueRowStatus } from './types.js'

const meta = {
  title: 'Components/IssueRow/Web',
  component: IssueRowWeb,
  args: {
    repo: 'night-orch/night-orch',
    issueNumber: 107,
    title: 'Storybook and components structure',
    status: 'running',
    branch: 'orch/issue-107',
    updatedAtIso: '2026-04-04T20:30:00Z',
  },
} satisfies Meta<typeof IssueRowWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const STATUS_SAMPLES: IssueRowStatus[] = ['queued', 'running', 'review', 'blocked', 'done']

export const StatusMatrix: Story = {
  render: (args) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {STATUS_SAMPLES.map((status) => (
        <IssueRowWeb
          key={status}
          {...args}
          status={status}
          title={`${status.toUpperCase()}: ${args.title}`}
        />
      ))}
    </div>
  ),
}
