import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { ConfigError, loadConfig, resolveConfigPath } from '../config/loader.js'

const DEFAULT_WEB_HOST = '127.0.0.1'
const DEFAULT_WEB_PORT = 3200
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000
const BODY_SNIPPET_LENGTH = 200

export interface SupervisorHealthTargets {
  webApiUrl: string
  webFrontendUrl: string
  webHostHeader: string | null
  runMcpUrl: string | null
}

export interface SupervisorHealthResolution {
  targets: SupervisorHealthTargets
  warnings: string[]
}

interface HealthProbeOptions {
  timeoutMs?: number
  expectedStatus?: number
  expectedContentTypePrefix?: string
  hostHeader?: string
}

export interface HealthProbeResult {
  ok: boolean
  detail: string
}

export function resolveSupervisorHealthTargets(
  projectRoot: string,
  globalArgs: string[],
  webArgs: string[],
): SupervisorHealthResolution {
  const rawWebHost = getOptionValue(webArgs, '--host') ?? DEFAULT_WEB_HOST
  const webHost = normalizeProbeHost(rawWebHost)
  const webPort = toPositiveInt(getOptionValue(webArgs, '--port'), DEFAULT_WEB_PORT)
  const allowedHosts = getOptionValues(webArgs, '--allowed-host')
    .map((entry) => normalizeHostname(entry))
    .filter((entry): entry is string => entry !== null)

  const targets: SupervisorHealthTargets = {
    webApiUrl: buildHttpUrl(webHost, webPort, '/api/health'),
    webFrontendUrl: buildHttpUrl(webHost, webPort, '/'),
    webHostHeader: isWildcardHost(rawWebHost) ? (allowedHosts[0] ?? null) : null,
    runMcpUrl: null,
  }

  const warnings: string[] = []

  try {
    const explicitConfigPath = getOptionValue(globalArgs, '--config')
    const trustWorkspace = hasFlag(globalArgs, '--trust-workspace')
    const configPath = resolveConfigPath(explicitConfigPath, { trustWorkspace })
    const config = loadConfig(configPath)

    if (config.mcp.enabled) {
      const runHost = normalizeProbeHost(config.mcp.httpHost)
      targets.runMcpUrl = buildHttpUrl(runHost, config.mcp.httpPort, '/health')
    }
  } catch (err) {
    const reason = err instanceof ConfigError ? err.message : (err as Error).message
    warnings.push(
      `Failed to resolve MCP health endpoint from config in ${projectRoot}: ${reason}. ` +
      'Falling back to run-process liveness checks.',
    )
  }

  return { targets, warnings }
}

export async function probeHealthEndpoint(
  url: string,
  options: HealthProbeOptions = {},
): Promise<HealthProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const expectedStatus = options.expectedStatus ?? 200
  const expectedContentTypePrefix = options.expectedContentTypePrefix?.toLowerCase()

  try {
    const response = await sendProbeRequest(url, timeoutMs, options.hostHeader)

    if (response.statusCode !== expectedStatus) {
      const snippet = summarizeResponseBody(response.body)
      const suffix = snippet ? ` body="${snippet}"` : ''
      return {
        ok: false,
        detail: `${url} returned HTTP ${response.statusCode} (expected ${expectedStatus})${suffix}`,
      }
    }

    if (expectedContentTypePrefix) {
      const contentType = (response.contentType ?? '').toLowerCase()
      if (!contentType.startsWith(expectedContentTypePrefix)) {
        const observed = contentType.length > 0 ? contentType : '(missing)'
        return {
          ok: false,
          detail: `${url} returned unexpected content-type "${observed}"`,
        }
      }
    }

    return { ok: true, detail: `${url} returned HTTP ${response.statusCode}` }
  } catch (err) {
    return {
      ok: false,
      detail: `${url} request failed: ${(err as Error).message}`,
    }
  }
}

function getOptionValue(args: string[], name: string): string | undefined {
  return getOptionValues(args, name).at(-1)
}

function getOptionValues(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) {
      continue
    }

    const candidate = args[index + 1]
    if (!candidate || candidate.startsWith('--')) {
      continue
    }
    values.push(candidate)
  }
  return values
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

function buildHttpUrl(host: string, port: number, pathname: string): string {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const url = new URL(`http://${formattedHost}:${port}`)
  url.pathname = pathname
  return url.toString()
}

function normalizeProbeHost(host: string): string {
  const normalized = host.trim()
  if (!normalized || normalized === '0.0.0.0' || normalized === '::') {
    return DEFAULT_WEB_HOST
  }
  return normalized
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const candidates = trimmed.includes('://')
    ? [trimmed]
    : [
        `http://${trimmed}`,
        ...(trimmed.includes(':') && !trimmed.startsWith('[') ? [`http://[${trimmed}]`] : []),
      ]

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      const hostname = parsed.hostname.toLowerCase()
      if (hostname.length > 0) {
        return hostname
      }
    } catch {
      // try next parse candidate
    }
  }

  return null
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostname(host)
  return normalized === '0.0.0.0' || normalized === '::'
}

function summarizeResponseBody(body: string): string {
  const normalized = body.trim().replace(/\s+/g, ' ')
  if (!normalized) {
    return ''
  }
  return normalized.slice(0, BODY_SNIPPET_LENGTH)
}

interface ProbeHttpResponse {
  statusCode: number
  contentType: string | null
  body: string
}

async function sendProbeRequest(
  url: string,
  timeoutMs: number,
  hostHeader: string | undefined,
): Promise<ProbeHttpResponse> {
  const parsed = new URL(url)
  const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  const signal = AbortSignal.timeout(timeoutMs)

  return new Promise<ProbeHttpResponse>((resolve, reject) => {
    const request = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        signal,
        headers: hostHeader ? { Host: hostHeader } : undefined,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: typeof response.headers['content-type'] === 'string'
              ? response.headers['content-type']
              : null,
            body,
          })
        })
      },
    )

    request.on('error', (error) => {
      reject(error)
    })

    request.end()
  })
}
