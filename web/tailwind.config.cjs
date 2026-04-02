const path = require('node:path')
const daisyui = require('daisyui')

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{ts,tsx}'),
  ],
  theme: {
    extend: {
      boxShadow: {
        panel: '0 20px 45px -28px rgb(2 8 23 / 0.85)',
      },
      backgroundImage: {
        'orch-admin':
          'radial-gradient(circle at 15% 0%, rgb(34 211 238 / 0.16), transparent 38%), radial-gradient(circle at 85% 8%, rgb(14 165 233 / 0.14), transparent 32%), radial-gradient(circle at 50% 100%, rgb(15 118 110 / 0.14), transparent 38%), linear-gradient(165deg, #040910 0%, #081221 52%, #0b1729 100%)',
      },
    },
  },
  plugins: [daisyui],
  daisyui: {
    themes: ['business'],
    darkTheme: 'business',
    logs: false,
  },
}
