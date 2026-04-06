/**
 * Thrown when a worker process exits due to an authentication/signed-out
 * condition. Caught by the loop engine to block immediately with a clear
 * remediation hint instead of retrying futilely.
 */
export class WorkerAuthError extends Error {
  readonly code = 'WORKER_AUTH_FAILURE' as const

  constructor(
    public readonly adapterType: string,
    public readonly remediation: string,
    public readonly detail: string,
  ) {
    super(`${adapterType} worker authentication failure: ${detail}`)
    this.name = 'WorkerAuthError'
  }
}
