import { spawn } from 'node:child_process'

export interface StreamingExecOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  stdin?: string
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

export interface StreamingExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
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

  let stdout = ''
  let stderr = ''
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let timedOut = false
  let forcedKillTimer: NodeJS.Timeout | null = null
  let spawnError: Error | null = null

  const flushTrailingBuffers = () => {
    const out = stdoutBuffer.trim()
    if (out) options.onStdoutLine?.(out)
    stdoutBuffer = ''

    const err = stderrBuffer.trim()
    if (err) options.onStderrLine?.(err)
    stderrBuffer = ''
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
    stdout += text
    stdoutBuffer = consumeLines(text, stdoutBuffer, options.onStdoutLine)
  })

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    stderr += text
    stderrBuffer = consumeLines(text, stderrBuffer, options.onStderrLine)
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

  if (spawnError && stderr.length === 0) {
    stderr = String(spawnError)
  }

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs: Date.now() - start,
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
