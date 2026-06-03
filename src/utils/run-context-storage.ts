import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-invocation context propagated through the async call stack via
 * Node's AsyncLocalStorage. Used so that deep helpers — currently the
 * prompt compiler — can read the current `runId` / `stepId` without
 * threading them through every parameter list.
 *
 * The engine wraps each phase execution in `withRunContext({...}, fn)`
 * before invoking the step executor. Helpers call `currentRunContext()` to
 * read the active values; `null` is returned outside any wrapped scope
 * (e.g. in unit tests that exercise the helper directly).
 */
export interface RunContextScope {
  runId: string
  stepId: string
  /** When true, observability hooks (prompt_compilations) skip writes. */
  skipPromptLogging?: boolean
}

const storage = new AsyncLocalStorage<RunContextScope>()

export function withRunContext<T>(scope: RunContextScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentRunContext(): RunContextScope | null {
  return storage.getStore() ?? null
}
