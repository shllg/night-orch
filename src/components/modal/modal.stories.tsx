import { type ReactElement, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ButtonWeb } from '../button/button.web.js'
import { ModalWeb } from './modal.web.js'
import type { ModalProps } from './types.js'

const meta = {
  title: 'Components/Modal/Web',
  component: ModalWeb,
  args: {
    open: true,
    title: 'Confirm branch cleanup',
    description: 'This action permanently removes stale worktrees.',
    closeOnBackdropClick: true,
    blocking: false,
    children: (
      <p className="mt-4 text-sm text-base-content/85">
        Modal bodies can render any children, including forms, status lists, and warnings.
      </p>
    ),
  },
} satisfies Meta<typeof ModalWeb>

export default meta
type Story = StoryObj<typeof meta>

export const Dismissible: Story = {
  render: (args) => <DismissiblePreview {...args} />,
}

export const Blocking: Story = {
  args: {
    title: 'Applying self-update',
    description: 'Dashboard controls stay locked until restart is healthy.',
    blocking: true,
    closeOnBackdropClick: true,
    children: (
      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="loading loading-spinner loading-md text-info" />
          <span>Installing and verifying the new build</span>
        </div>
        <p className="text-xs text-base-content/70">
          Backdrop clicks and close controls are disabled while blocking mode is active.
        </p>
      </div>
    ),
  },
}

function DismissiblePreview(args: ModalProps): ReactElement {
  const [open, setOpen] = useState<boolean>(args.open)

  return (
    <div className="flex min-h-[26rem] items-center justify-center">
      <ButtonWeb type="button" tone="primary" size="sm" onClick={() => setOpen(true)}>
        Open modal
      </ButtonWeb>
      <ModalWeb
        {...args}
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        actions={
          <>
            <ButtonWeb type="button" tone="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </ButtonWeb>
            <ButtonWeb type="button" tone="error" size="sm" onClick={() => setOpen(false)}>
              Remove worktrees
            </ButtonWeb>
          </>
        }
      />
    </div>
  )
}
