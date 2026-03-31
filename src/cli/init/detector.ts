import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProjectDetection {
  type: 'node' | 'rust' | 'go' | 'python' | 'ruby' | 'unknown'
  verifyCommands: string[]
  baseBranch: string
}

const DETECTORS: Array<{
  type: ProjectDetection['type']
  files: string[]
  verify: string[]
}> = [
  { type: 'node', files: ['package.json'], verify: ['pnpm test', 'pnpm typecheck'] },
  { type: 'rust', files: ['Cargo.toml'], verify: ['cargo test', 'cargo clippy'] },
  { type: 'go', files: ['go.mod'], verify: ['go test ./...', 'go vet ./...'] },
  { type: 'python', files: ['pyproject.toml', 'setup.py'], verify: ['pytest', 'mypy .'] },
  { type: 'ruby', files: ['Gemfile'], verify: ['bundle exec rspec', 'bundle exec rubocop'] },
]

export async function detectProjectType(dirPath: string): Promise<ProjectDetection> {
  for (const detector of DETECTORS) {
    for (const file of detector.files) {
      try {
        await access(join(dirPath, file))
        const baseBranch = await detectBaseBranch(dirPath)
        return { type: detector.type, verifyCommands: detector.verify, baseBranch }
      } catch {
        // File not found — try next
      }
    }
  }

  const baseBranch = await detectBaseBranch(dirPath)
  return { type: 'unknown', verifyCommands: [], baseBranch }
}

async function detectBaseBranch(dirPath: string): Promise<string> {
  try {
    const head = await readFile(join(dirPath, '.git', 'HEAD'), 'utf-8')
    // If HEAD points to main or master, use that
    if (head.includes('refs/heads/main')) return 'main'
    if (head.includes('refs/heads/master')) return 'master'
  } catch {
    // Not a git repo or can't read HEAD
  }
  return 'main'
}
