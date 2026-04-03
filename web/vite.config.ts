import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_VERSION = readPackageVersion() ?? '0.1.0'
const FRONTEND_GIT_SHA = readGitSha() ?? 'unknown'

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [tailwindcss(), react()],
  define: {
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(FRONTEND_VERSION),
    'import.meta.env.VITE_BUILD_GIT_SHA': JSON.stringify(FRONTEND_GIT_SHA),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
})

function readPackageVersion(): string | null {
  try {
    const packagePath = resolve(import.meta.dirname, '../package.json')
    const raw = readFileSync(packagePath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version !== 'string') return null
    const version = parsed.version.trim()
    return version.length > 0 ? version : null
  } catch {
    return null
  }
}

function readGitSha(): string | null {
  try {
    const projectRoot = resolve(import.meta.dirname, '..')
    const sha = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase()
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}
