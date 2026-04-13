import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Night-Orch',
  description: 'Autonomous AI coding orchestrator',
  base: '/night-orch/',
  themeConfig: {
    nav: [
      { text: 'Overview', link: '/OVERVIEW' },
      { text: 'Usage', link: '/USAGE' },
      { text: 'Configuration', link: '/CONFIGURATION' },
      { text: 'Deployment', link: '/deployment' },
      { text: 'Single-user', link: '/single-user' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/OVERVIEW' },
          { text: 'Usage', link: '/USAGE' },
          { text: 'Configuration', link: '/CONFIGURATION' },
          { text: 'Deployment', link: '/deployment' },
          { text: 'Single-user deployment', link: '/single-user' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/shllg/night-orch' },
    ],
  },
})
