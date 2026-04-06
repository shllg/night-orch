import { existsSync } from 'node:fs'
import { cp, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveProjectRoot } from '../../utils/project-root.js'

export async function monitoringInitCommand(targetDir?: string): Promise<void> {
  const packageRoot = resolveProjectRoot()
  const dest = resolve(targetDir ?? process.cwd())

  const composeSrc = resolve(packageRoot, 'docker-compose.example.yaml')
  const monitoringSrc = resolve(packageRoot, 'monitoring')

  if (!existsSync(composeSrc)) {
    process.stderr.write('Error: docker-compose.example.yaml not found in package.\n')
    process.exitCode = 1
    return
  }

  if (!existsSync(monitoringSrc)) {
    process.stderr.write('Error: monitoring/ directory not found in package.\n')
    process.exitCode = 1
    return
  }

  const composeDest = resolve(dest, 'docker-compose.yaml')
  const monitoringDest = resolve(dest, 'monitoring')

  if (existsSync(composeDest)) {
    process.stderr.write(`Skipping: ${composeDest} already exists\n`)
  } else {
    await cp(composeSrc, composeDest)
    process.stdout.write(`Created ${composeDest}\n`)
  }

  if (existsSync(monitoringDest)) {
    process.stderr.write(`Skipping: ${monitoringDest} already exists\n`)
  } else {
    await cp(monitoringSrc, monitoringDest, { recursive: true })
    const files = await readdir(monitoringDest, { recursive: true })
    process.stdout.write(`Created ${monitoringDest}/ (${files.length} files)\n`)
  }

  process.stdout.write(
    '\nSetup:\n' +
    '  1. Set GRAFANA_ADMIN_PASSWORD in your .env file\n' +
    '  2. Run: docker compose up -d\n' +
    '  3. Grafana:    http://localhost:3001\n' +
    '     Prometheus: http://localhost:9091\n',
  )
}
