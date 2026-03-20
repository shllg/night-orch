import { nanoid } from 'nanoid'

export function generateRunId(): string {
  return `run-${nanoid(12)}`
}

export function slugify(input: string, maxLength = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '')
}

export function branchName(
  prefix: string,
  issueNumber: number,
  slug: string,
): string {
  return `${prefix}/${issueNumber}-${slug}`
}
