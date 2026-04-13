import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'
import { mergeConfig, type UserConfig } from 'vite'

const config: StorybookConfig = {
  stories: ['../src/components/**/*.stories.@(ts|tsx)', '../web/src/components/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (viteConfig): Promise<UserConfig> =>
    mergeConfig(viteConfig, {
      plugins: [tailwindcss()],
    }),
}

export default config
