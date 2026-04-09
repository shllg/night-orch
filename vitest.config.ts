import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@xterm/addon-fit': new URL('test/__mocks__/@xterm/addon-fit.ts', import.meta.url).pathname,
      '@xterm/xterm/css/xterm.css': new URL('test/__mocks__/@xterm/xterm-css.ts', import.meta.url).pathname,
      '@xterm/xterm': new URL('test/__mocks__/@xterm/xterm.ts', import.meta.url).pathname,
    },
  },
  test: {
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 75,
        branches: 70,
        functions: 75,
        statements: 75,
      },
    },
  },
})
