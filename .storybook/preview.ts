import { createElement } from 'react'
import type { Preview } from '@storybook/react-vite'
import '../web/src/index.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'night-orch',
      values: [
        {
          name: 'night-orch',
          value: '#040910',
        },
      ],
    },
    controls: {
      expanded: true,
    },
    options: {
      storySort: {
        order: ['00 — Overview', 'Components'],
      },
    },
  },
  decorators: [
    (Story) =>
      createElement(
        'div',
        {
          'data-theme': 'black',
          className: 'min-h-screen bg-orch-admin px-6 py-8 text-base-content',
        },
        createElement(Story),
      ),
  ],
}

export default preview
