import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { detectProjectType } from '../init/detector.js'
import { generateConfigYaml, type InitConfig } from '../init/templates.js'

export async function runInit(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })

  try {
    console.log('\n  night-orch setup wizard\n')

    // Step 1: GitHub token
    const tokenEnv = (await rl.question('  GitHub token env var name [GITHUB_TOKEN]: ')) || 'GITHUB_TOKEN'
    const tokenValue = process.env[tokenEnv]
    if (!tokenValue) {
      console.log(`  Warning: ${tokenEnv} is not set in your environment`)
    } else {
      console.log(`  Found ${tokenEnv} in environment`)
    }

    // Step 2: Repository
    const repo = await rl.question('  Repository (owner/name): ')
    if (!repo.includes('/')) {
      console.log('  Error: Repository must be in owner/name format')
      return
    }

    // Step 3: Local path
    const defaultPath = resolve(join(homedir(), 'code', repo))
    const localPath = (await rl.question(`  Local clone path [${defaultPath}]: `)) || defaultPath

    // Step 4: Detect project type
    console.log(`\n  Detecting project type in ${localPath}...`)
    const detection = await detectProjectType(localPath)
    console.log(`  Detected: ${detection.type}`)
    if (detection.verifyCommands.length > 0) {
      console.log(`  Suggested verify commands: ${detection.verifyCommands.join(', ')}`)
    }

    const useDetected = await rl.question('  Use detected settings? [Y/n]: ')
    const verifyCommands =
      useDetected.toLowerCase() === 'n'
        ? (await rl.question('  Verify commands (comma-separated): '))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : detection.verifyCommands

    // Step 5: Worker type
    const workerChoice = (await rl.question('  Worker type (claude/codex/opencode/acp) [claude]: ')) || 'claude'
    const workerType = (['claude', 'codex', 'opencode', 'acp'].includes(workerChoice) ? workerChoice : 'claude') as InitConfig['workerType']

    // Step 6: Generate and write config
    const config = generateConfigYaml({
      tokenEnv,
      repo,
      localPath,
      baseBranch: detection.baseBranch,
      verifyCommands,
      workerType,
    })

    const configDir = join(homedir(), '.config', 'night-orch')
    const configPath = join(configDir, 'config.yaml')
    await mkdir(configDir, { recursive: true })
    await writeFile(configPath, config, 'utf-8')
    console.log(`\n  Config written to ${configPath}`)

    // Step 7: Suggest next steps
    console.log('\n  Next steps:')
    console.log('    1. Review the config: cat ' + configPath)
    console.log('    2. Run diagnostics: night-orch doctor')
    console.log('    3. Initialize labels: night-orch labels-init')
    console.log('    4. Start the orchestrator: night-orch run')
    console.log('')
  } finally {
    rl.close()
  }
}
