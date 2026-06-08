import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReloadController,
  requestExternalReload,
  resolveExternalReloadTriggerPath,
} from '../../src/poller/reload-control.js'

describe('ReloadController', () => {
  const cleanupFns: Array<() => void> = []

  afterEach(() => {
    while (cleanupFns.length > 0) cleanupFns.pop()?.()
  })

  it('returns false when no reload has been requested', () => {
    const controller = new ReloadController()
    expect(controller.consume()).toBe(false)
  })

  it('consumes a pending reload exactly once after requestReload()', () => {
    const controller = new ReloadController()
    controller.requestReload()
    expect(controller.consume()).toBe(true)
    expect(controller.consume()).toBe(false)
  })

  it('coalesces repeated requestReload() calls into one consume()', () => {
    const controller = new ReloadController()
    controller.requestReload()
    controller.requestReload()
    controller.requestReload()
    expect(controller.consume()).toBe(true)
    expect(controller.consume()).toBe(false)
  })

  it('signals a reload after SIGHUP', () => {
    const controller = new ReloadController()
    const unregister = controller.register()
    cleanupFns.push(unregister)

    process.emit('SIGHUP')
    expect(controller.consume()).toBe(true)
    expect(controller.consume()).toBe(false)
  })

  it('stops responding to SIGHUP after unregister()', () => {
    const controller = new ReloadController()
    const unregister = controller.register()
    unregister()

    process.emit('SIGHUP')
    expect(controller.consume()).toBe(false)
  })

  it('consumes an external trigger file and removes it', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'night-orch-reload-'))
    cleanupFns.push(() => rmSync(tempDir, { recursive: true, force: true }))
    const triggerPath = join(tempDir, 'reload-request')
    writeFileSync(triggerPath, 'queued')

    const controller = new ReloadController(triggerPath)
    expect(controller.consume()).toBe(true)
    expect(existsSync(triggerPath)).toBe(false)
    expect(controller.consume()).toBe(false)
  })

  it('treats SIGHUP and trigger file as the same logical signal within one consume', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'night-orch-reload-'))
    cleanupFns.push(() => rmSync(tempDir, { recursive: true, force: true }))
    const triggerPath = join(tempDir, 'reload-request')
    writeFileSync(triggerPath, 'queued')

    const controller = new ReloadController(triggerPath)
    const unregister = controller.register()
    cleanupFns.push(unregister)
    process.emit('SIGHUP')

    expect(controller.consume()).toBe(true)
    expect(existsSync(triggerPath)).toBe(false)
    expect(controller.consume()).toBe(false)
  })
})

describe('resolveExternalReloadTriggerPath', () => {
  it('is deterministic per dbPath', () => {
    const a = resolveExternalReloadTriggerPath('/var/lib/night-orch/state.sqlite')
    const b = resolveExternalReloadTriggerPath('/var/lib/night-orch/state.sqlite')
    expect(a).toBe(b)
  })

  it('differs between dbPaths', () => {
    const a = resolveExternalReloadTriggerPath('/var/lib/night-orch/state.sqlite')
    const b = resolveExternalReloadTriggerPath('/var/lib/night-orch/other.sqlite')
    expect(a).not.toBe(b)
  })

  it('uses reload-request prefix to disambiguate from poll-request', () => {
    const reload = resolveExternalReloadTriggerPath('/var/lib/night-orch/state.sqlite')
    expect(reload).toMatch(/reload-request-[0-9a-f]+$/)
  })
})

describe('requestExternalReload', () => {
  it('creates a trigger file at the resolved path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'night-orch-reload-'))
    try {
      const dbPath = join(tempDir, 'state.sqlite')
      const result = requestExternalReload(dbPath)
      expect(result.accepted).toBe(true)
      expect(result.mechanism).toBe('trigger-file')
      expect(existsSync(result.triggerPath)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
