import { handleToolCall } from '../../mcp/tools/index.js'
import {
  RuntimeSettingInputError,
} from '../../settings/runtime.js'
import type { RouteHandler } from './context.js'
import {
  writeJson,
  readJsonBody,
  toNonEmptyString,
  withMcpMutationAuth,
} from '../server.js'
import { buildSettingsSnapshot } from '../snapshots.js'

export const handleSettingsRoutes: RouteHandler = async (req, res, method, pathname, _searchParams, ctx) => {
  const { deps, security, rawConfig } = ctx

  if (method === 'GET' && pathname === '/api/settings') {
    const snapshot = buildSettingsSnapshot(deps, rawConfig)
    writeJson(res, 200, snapshot)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/settings/set') {
    const body = await readJsonBody(req)
    const key = toNonEmptyString(body['key'])
    const value = body['value']

    if (!key || value === undefined) {
      writeJson(res, 400, { error: 'key and value are required' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-set-setting',
        withMcpMutationAuth({ key, value }, security),
        deps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      if (isRuntimeSettingInputError(err)) {
        writeJson(res, 400, { error: (err as Error).message })
        return true
      }
      throw err
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/settings/clear') {
    const body = await readJsonBody(req)
    const key = toNonEmptyString(body['key'])

    if (!key) {
      writeJson(res, 400, { error: 'key is required' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-clear-setting',
        withMcpMutationAuth({ key }, security),
        deps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      if (isRuntimeSettingInputError(err)) {
        writeJson(res, 400, { error: (err as Error).message })
        return true
      }
      throw err
    }
    return true
  }

  return false
}

function isRuntimeSettingInputError(err: unknown): err is RuntimeSettingInputError {
  if (err instanceof RuntimeSettingInputError) {
    return true
  }
  return err instanceof Error && err.name === 'RuntimeSettingInputError'
}
