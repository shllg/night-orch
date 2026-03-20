import { execa } from 'execa'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
}

/**
 * Execute a command with timeout. Kills process group on timeout.
 */
export async function execWithTimeout(
  command: string,
  args: string[],
  opts: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    stdin?: string
  },
): Promise<ExecResult> {
  const start = Date.now()

  try {
    const result = await execa(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs,
      reject: false,
      input: opts.stdin,
      killSignal: 'SIGTERM',
      forceKillAfterDelay: 5000,
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut ?? false,
      durationMs: Date.now() - start,
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - start
    const e = err as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      exitCode: e.exitCode ?? 1,
      timedOut: e.timedOut ?? (durationMs >= opts.timeoutMs),
      durationMs,
    }
  }
}
