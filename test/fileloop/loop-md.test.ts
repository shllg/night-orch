import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendLoopNote, parseLoopEntries, tailLoopMd, topLoopEntries } from '../../src/fileloop/loop-md.js'

describe('file-loop loop.md helper', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-fileloop-loopmd-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appends escaped notes and reads top entries', async () => {
    await appendLoopNote(tmpDir, 'loop.md', 'src/a.ts', 'Needs follow-up --> extract helper')
    await appendLoopNote(tmpDir, 'loop.md', 'src/b.ts', 'Split validation from IO')

    const top = await topLoopEntries(tmpDir, 'loop.md', 2)
    expect(top).toEqual([
      { filePath: 'src/a.ts', note: 'Needs follow-up --> extract helper' },
      { filePath: 'src/b.ts', note: 'Split validation from IO' },
    ])
  })

  it('tails existing content and parses entries', async () => {
    writeFileSync(join(tmpDir, 'loop.md'), '## src/a.ts\n<!-- file-loop note: Refactor later -->\n', 'utf8')

    const tail = await tailLoopMd(tmpDir, 'loop.md', 12)
    expect(tail).toContain('later -->')
    expect(parseLoopEntries('## src/a.ts\n<!-- file-loop note: Refactor later -->\n')).toEqual([
      { filePath: 'src/a.ts', note: 'Refactor later' },
    ])
  })
})
