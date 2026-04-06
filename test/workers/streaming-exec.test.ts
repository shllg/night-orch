import { describe, it, expect } from 'vitest'
import { streamingExec } from '../../src/workers/streaming-exec.js'

describe('streamingExec', () => {
  it('captures small stdout/stderr without truncation', async () => {
    const result = await streamingExec({
      command: 'node',
      args: ['-e', 'process.stdout.write("hello"); process.stderr.write("world")'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 10_000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('world')
    expect(result.outputTruncated).toBe(false)
  })

  it('caps stdout to the configured tail when output exceeds the cap', async () => {
    // Emit 3 MB of stdout in 16 KB chunks.
    const script = `
      const chunk = 'x'.repeat(16 * 1024);
      for (let i = 0; i < 200; i++) process.stdout.write(chunk);
    `
    const result = await streamingExec({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 30_000,
      streamTailCapBytes: 512 * 1024, // 512 KB cap
    })

    expect(result.exitCode).toBe(0)
    expect(result.outputTruncated).toBe(true)
    // Total observed bytes roughly 200*16*1024 = 3.2 MB
    expect(result.stdoutBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024)
    // stdout string should be bounded (cap + notice suffix). Expect well under 1 MB.
    expect(result.stdout.length).toBeLessThan(700 * 1024)
    expect(result.stdout).toContain('[night-orch: stdout truncated')
  }, 30_000)

  it('surfaces truncation flag for stderr as well', async () => {
    const script = `
      const chunk = 'y'.repeat(8 * 1024);
      for (let i = 0; i < 300; i++) process.stderr.write(chunk);
    `
    const result = await streamingExec({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 30_000,
      streamTailCapBytes: 256 * 1024,
    })

    expect(result.outputTruncated).toBe(true)
    expect(result.stderr).toContain('[night-orch: stderr truncated')
  }, 30_000)

  it('reports non-zero exit code', async () => {
    const result = await streamingExec({
      command: 'node',
      args: ['-e', 'process.exit(7)'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(7)
  })
})
