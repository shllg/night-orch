import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const DEFAULT_MONITORING_DIR = resolve(homedir(), '.config', 'night-orch', 'monitoring')

function resolveMonitoringDir(dir?: string): string {
  return dir ? resolve(dir) : DEFAULT_MONITORING_DIR
}

/** Resolve the bundled monitoring templates shipped with the npm package. */
function resolvePackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

interface MonitoringInitOpts {
  dir?: string
  force?: boolean
}

export async function monitoringInitCommand(opts: MonitoringInitOpts): Promise<void> {
  const targetDir = resolveMonitoringDir(opts.dir)
  const packageRoot = resolvePackageRoot()
  const templateDir = resolve(packageRoot, 'monitoring')
  const composeTemplate = resolve(packageRoot, 'docker-compose.example.yaml')

  if (!existsSync(templateDir)) {
    console.error(
      `Monitoring templates not found at ${templateDir}.\n` +
        'This may happen if the package was not installed correctly.',
    )
    process.exitCode = 1
    return
  }

  mkdirSync(targetDir, { recursive: true })

  // Copy docker-compose template with volume paths adjusted for flat layout.
  // The template uses ./monitoring/... paths (relative to repo root), but the
  // extracted layout places everything as siblings of docker-compose.yaml.
  const composeTarget = resolve(targetDir, 'docker-compose.yaml')
  if (existsSync(composeTarget) && !opts.force) {
    console.log(`  skip  ${composeTarget} (already exists, use --force to overwrite)`)
  } else {
    let composeContent = readFileSync(composeTemplate, 'utf8')
    composeContent = composeContent.replace(/\.\/monitoring\//g, './')
    writeFileSync(composeTarget, composeContent)
    console.log(`  wrote ${composeTarget}`)
  }

  // Copy monitoring configs (prometheus.yml, grafana/)
  const entries = [
    'prometheus.yml',
    'grafana/dashboards/night-orch.json',
    'grafana/provisioning/datasources/prometheus.yml',
    'grafana/provisioning/dashboards/dashboards.yml',
  ]

  for (const entry of entries) {
    const src = resolve(templateDir, entry)
    const dest = resolve(targetDir, entry)

    if (!existsSync(src)) continue

    if (existsSync(dest) && !opts.force) {
      console.log(`  skip  ${dest} (already exists)`)
      continue
    }

    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest)
    console.log(`  wrote ${dest}`)
  }

  console.log(`\nMonitoring configs initialized in ${targetDir}`)
  console.log('\nNext steps:')
  console.log('  1. Set GRAFANA_ADMIN_PASSWORD in your environment or .env file')
  console.log('  2. Run: night-orch monitoring up')
  console.log('  3. Open Grafana at http://localhost:3001')
}

interface MonitoringComposeOpts {
  dir?: string
}

function resolveComposeFile(dir?: string): string {
  const monitoringDir = resolveMonitoringDir(dir)
  const composePath = resolve(monitoringDir, 'docker-compose.yaml')

  if (!existsSync(composePath)) {
    console.error(
      `Docker Compose file not found at ${composePath}.\n` +
        'Run "night-orch monitoring init" first to set up monitoring configs.',
    )
    process.exitCode = 1
    throw new Error('compose file not found')
  }

  return composePath
}

export async function monitoringUpCommand(opts: MonitoringComposeOpts): Promise<void> {
  const composePath = resolveComposeFile(opts.dir)
  await execa('docker', ['compose', '-f', composePath, 'up', '-d'], { stdio: 'inherit' })
}

export async function monitoringDownCommand(opts: MonitoringComposeOpts): Promise<void> {
  const composePath = resolveComposeFile(opts.dir)
  await execa('docker', ['compose', '-f', composePath, 'down'], { stdio: 'inherit' })
}

export async function monitoringLogsCommand(opts: MonitoringComposeOpts): Promise<void> {
  const composePath = resolveComposeFile(opts.dir)
  await execa('docker', ['compose', '-f', composePath, 'logs', '-f'], { stdio: 'inherit' })
}
