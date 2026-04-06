import { spawn } from 'node:child_process'

/**
 * Per-stream cap for captured worker output. AI workers emit streaming
 * JSONL and can easily produce tens of megabytes of output per run; with
 * `maxConcurrentRuns > 1` an unbounded accumulator would OOM the daemon
 * well before the worker's own timeout fires. We keep the TAIL (parsers
 * only need the latest messages) and report how many bytes were dropped
 * so callers can surface a diagnostic to the user.
 */
const DEFAULT_STREAM_TAIL_CAP = 16 * 1024 * 1024

export interface StreamingExecOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  stdin?: string
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Override per-stream cap for tests or special-purpose invocations. */
  streamTailCapBytes?: number
}

export interface StreamingExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  /** True if stdout or stderr was truncated to the tail cap. */
  outputTruncated: boolean
  /** Approximate total bytes observed on each stream, pre-truncation. */
  stdoutBytes: number
  stderrBytes: number
}

/**
 * Bounded ring buffer that preserves the tail of a streaming input. Writes
 * are amortized — we append until the buffer grows beyond 2× the cap, then
 * slice back to cap. This avoids per-chunk allocation for the common case
 * of small chunks while still guaranteeing bounded memory.
 */
class TailBuffer {
  private data = ''
  private _totalBytes = 0
  private _truncated = false

  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    this._totalBytes += chunk.length
    this.data += chunk
    if (this.data.length > this.cap * 2) {
      this.data = this.data.slice(-this.cap)
      this._truncated = true
    }
  }

  toString(): string {
    if (this.data.length > this.cap) {
      this._truncated = true
      return this.data.slice(-this.cap)
    }
    return this.data
  }

  get truncated(): boolean {
    return this._truncated
  }

  get totalBytes(): number {
    return this._totalBytes
  }
}

export async function streamingExec(options: StreamingExecOptions): Promise<StreamingExecResult> {
  const start = Date.now()
  const useDetached = process.platform !== 'win32'
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    detached: useDetached,
  })

  const cap = options.streamTailCapBytes ?? DEFAULT_STREAM_TAIL_CAP
  const stdoutBuf = new TailBuffer(cap)
  const stderrBuf = new TailBuffer(cap)
  let stdoutLineBuffer = ''
  let stderrLineBuffer = ''
  let timedOut = false
  let forcedKillTimer: NodeJS.Timeout | null = null
  let spawnError: Error | null = null

  const flushTrailingBuffers = () => {
    const out = stdoutLineBuffer.trim()
    if (out) options.onStdoutLine?.(out)
    stdoutLineBuffer = ''

    const err = stderrLineBuffer.trim()
    if (err) options.onStderrLine?.(err)
    stderrLineBuffer = ''
  }

  const consumeLines = (
    chunkText: string,
    prior: string,
    handler?: (line: string) => void,
  ): string => {
    let buffer = prior + chunkText
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      if (line.length > 0) handler?.(line)
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
    }
    return buffer
  }

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    stdoutBuf.append(text)
    stdoutLineBuffer = consumeLines(text, stdoutLineBuffer, options.onStdoutLine)
  })

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    stderrBuf.append(text)
    stderrLineBuffer = consumeLines(text, stderrLineBuffer, options.onStderrLine)
  })

  child.on('error', (err: unknown) => {
    spawnError = err instanceof Error ? err : new Error(String(err))
  })

  if (options.stdin) {
    child.stdin?.write(options.stdin)
  }
  child.stdin?.end()

  const timeoutTimer = setTimeout(() => {
    timedOut = true
    terminateProcess(child.pid, useDetached, 'SIGTERM')
    forcedKillTimer = setTimeout(() => {
      terminateProcess(child.pid, useDetached, 'SIGKILL')
    }, 5_000)
  }, options.timeoutMs)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer)
      }
      resolve(code ?? (timedOut ? 124 : 1))
    })
  })

  clearTimeout(timeoutTimer)
  flushTrailingBuffers()

  let stdout = stdoutBuf.toString()
  let stderr = stderrBuf.toString()

  if (spawnError && stderr.length === 0) {
    stderr = String(spawnError)
  }

  const outputTruncated = stdoutBuf.truncated || stderrBuf.truncated
  if (outputTruncated) {
    const stdoutNotice = stdoutBuf.truncated
      ? `\n[night-orch: stdout truncated — kept last ${stdout.length} of ${stdoutBuf.totalBytes} bytes]`
      : ''
    const stderrNotice = stderrBuf.truncated
      ? `\n[night-orch: stderr truncated — kept last ${stderr.length} of ${stderrBuf.totalBytes} bytes]`
      : ''
    stdout = stdout + stdoutNotice
    stderr = stderr + stderrNotice
  }

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs: Date.now() - start,
    outputTruncated,
    stdoutBytes: stdoutBuf.totalBytes,
    stderrBytes: stderrBuf.totalBytes,
  }
}

function terminateProcess(
  pid: number | undefined,
  useDetached: boolean,
  signal: NodeJS.Signals,
): void {
  if (!pid) return
  try {
    if (useDetached) {
      process.kill(-pid, signal)
      return
    }
  } catch {
    // Fall through to direct child signal.
  }

  try {
    process.kill(pid, signal)
  } catch {
    // Ignore if process already exited.
  }
}
