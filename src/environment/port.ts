import net from 'node:net'
import { logger } from '../utils/logger.js'

/** Result of attempting to bind one host address. */
interface BindProbe {
  ok: boolean
  code?: string
}

/** Try to bind `port` on `host`; resolves the outcome without throwing. */
function tryBind(port: number, host: string): Promise<BindProbe> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code }))
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve({ ok: true }))
    })
  })
}

let warnedCannotProbe = false

/**
 * Best-effort check that a host port is free. Probes the IPv4 wildcard
 * (`0.0.0.0`, where docker publishes) and, if that binds, the IPv6 wildcard.
 *
 * - `EADDRINUSE` ⇒ taken (false).
 * - `EADDRNOTAVAIL`/`EAFNOSUPPORT` on `::` ⇒ no IPv6 stack, not a conflict (free).
 * - `EACCES`/`EPERM` ⇒ the probe itself is not permitted (sandboxed host). We
 *   cannot tell, so **fail open** (true) with a one-time warning rather than
 *   declaring every port dead and bricking dispatch.
 *
 * This narrows collisions but cannot promise freedom — only the consuming
 * service's `bind()` is authoritative (TOCTOU).
 */
export async function isPortFree(port: number): Promise<boolean> {
  const v4 = await tryBind(port, '0.0.0.0')
  if (!v4.ok && !isFreeIndicating(v4.code, port)) return false
  const v6 = await tryBind(port, '::')
  if (!v6.ok && !isFreeIndicating(v6.code, port)) return false
  return true
}

/**
 * Decide, for a failed bind, whether the error means the port is NOT a conflict
 * (so we can still hand it out). Only `EADDRINUSE` is a hard conflict. A
 * permission error means we cannot probe at all — fail open with a one-time
 * warning. Any other unexpected code is also treated as non-conflicting
 * (best-effort; the consuming service's own `bind` stays authoritative), logged
 * at debug for visibility. Applied identically to IPv4 and IPv6 so a stack quirk
 * on one family never silently burns a candidate port.
 */
function isFreeIndicating(code: string | undefined, port: number): boolean {
  if (code === 'EADDRINUSE') return false
  if (code === 'EACCES' || code === 'EPERM') {
    if (!warnedCannotProbe) {
      warnedCannotProbe = true
      logger.warn({ code }, 'Cannot probe host port availability (permission denied) — falling back to in-memory tracking only')
    }
    return true
  }
  logger.debug({ code, port }, 'Unexpected port-probe error — treating port as available (best-effort)')
  return true
}

// Allocation runs under a global async mutex: the reserve+probe critical section
// must not interleave across concurrent runs (which share `usedPorts`), or two
// runs could probe-then-claim the same port across the `await`. Probing 1–few
// ports is millisecond-cheap, so serializing allocation is correct and the lost
// parallelism is negligible.
let allocTail: Promise<void> = Promise.resolve()

function lockAllocation(): Promise<() => void> {
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  const prev = allocTail
  allocTail = allocTail.then(() => next)
  return prev.then(() => release)
}

/**
 * Reserve the first host-bindable port in `range` not already in `usedPorts`.
 * On success the chosen port is pushed into `usedPorts` (the per-pass set) and
 * returned. Ports that fail the bind probe are skipped. Throws when the whole
 * range is in use or host-bound — the caller treats that as a retryable infra
 * error.
 */
export async function allocatePort(range: { min: number; max: number }, usedPorts: number[]): Promise<number> {
  const release = await lockAllocation()
  try {
    const used = new Set(usedPorts)
    for (let port = range.min; port <= range.max; port++) {
      if (used.has(port)) continue
      if (await isPortFree(port)) {
        usedPorts.push(port)
        return port
      }
      used.add(port) // host-bound — don't re-probe this number this pass
    }
    throw new Error(
      `Port range ${range.min}-${range.max} exhausted: all in use or host-bound (${usedPorts.length} reserved this pass)`,
    )
  } finally {
    release()
  }
}
