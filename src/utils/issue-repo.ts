export function resolveIssueRepo(
  phaseData: Record<string, unknown> | null | undefined,
  fallbackRepo: string,
): string {
  const issueRepo = phaseData?.['issueRepo']
  return typeof issueRepo === 'string' && issueRepo.length > 0
    ? issueRepo
    : fallbackRepo
}
