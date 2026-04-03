import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

type ComposeFile = {
  services?: {
    prometheus?: {
      extra_hosts?: string[]
    }
  }
}

type PrometheusConfigFile = {
  scrape_configs?: Array<{
    job_name?: string
    static_configs?: Array<{
      targets?: string[]
    }>
  }>
}

type GrafanaDatasourcesFile = {
  datasources?: Array<{
    name?: string
    url?: string
  }>
}

function loadYamlFile<T>(relativePath: string): T {
  const content = readFileSync(
    resolve(import.meta.dirname, '../../', relativePath),
    'utf-8',
  )
  return parseYaml(content) as T
}

describe('Monitoring Docker wiring', () => {
  it('configures Prometheus to scrape a host-reachable metrics endpoint', () => {
    const compose = loadYamlFile<ComposeFile>('docker-compose.example.yaml')
    const prometheus = loadYamlFile<PrometheusConfigFile>('monitoring/prometheus.yml')

    expect(compose.services?.prometheus?.extra_hosts ?? []).toContain('host.docker.internal:host-gateway')

    const nightOrchJob = prometheus.scrape_configs?.find((job) => job.job_name === 'night-orch')
    expect(nightOrchJob).toBeDefined()
    const targets = (nightOrchJob?.static_configs ?? []).flatMap((entry) => entry.targets ?? [])

    expect(targets).toContain('host.docker.internal:9090')
    expect(targets).not.toContain('127.0.0.1:9090')
  })

  it('configures Grafana to query Prometheus over the Docker service network', () => {
    const datasource = loadYamlFile<GrafanaDatasourcesFile>(
      'monitoring/grafana/provisioning/datasources/prometheus.yml',
    )

    const prometheusDatasource = datasource.datasources?.find((item) => item.name === 'Prometheus')
    expect(prometheusDatasource).toBeDefined()
    expect(prometheusDatasource?.url).toBe('http://prometheus:9090')
    expect(prometheusDatasource?.url).not.toContain('127.0.0.1')
  })
})
