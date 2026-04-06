#!/usr/bin/env node

/**
 * Detect the appropriate semver bump from commit messages since the last tag.
 *
 * Maps the project's [CATEGORY] commit format to semver:
 *   major  — commits containing "BREAKING" in the message
 *   minor  — [FEATURE]
 *   patch  — [FIX], [REFACTOR], [CHORE], [INTERNAL], [DOCS], [TEST]
 *   none   — no releasable commits found
 *
 * Outputs one of: major, minor, patch, none
 */

import { execFileSync } from 'node:child_process'

const MAJOR_PATTERN = /BREAKING/i
const MINOR_CATEGORIES = new Set(['FEATURE'])
const PATCH_CATEGORIES = new Set(['FIX', 'REFACTOR', 'CHORE', 'INTERNAL', 'DOCS', 'TEST'])
const CATEGORY_RE = /^\[([A-Z]+)\]/

function getCommitsSinceLastTag() {
  let range
  try {
    const lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    range = `${lastTag}..HEAD`
  } catch {
    // No tags yet — use all commits
    range = 'HEAD'
  }

  const log = execFileSync('git', ['log', range, '--pretty=format:%s'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

  return log.length > 0 ? log.split('\n') : []
}

function detectBump(messages) {
  let bump = 'none'

  for (const msg of messages) {
    if (MAJOR_PATTERN.test(msg)) {
      process.stdout.write('major\n')
      return
    }

    const match = CATEGORY_RE.exec(msg)
    if (!match?.[1]) continue
    const category = match[1]

    if (MINOR_CATEGORIES.has(category) && bump !== 'minor') {
      bump = 'minor'
    } else if (PATCH_CATEGORIES.has(category) && bump === 'none') {
      bump = 'patch'
    }
  }

  process.stdout.write(`${bump}\n`)
}

const messages = getCommitsSinceLastTag()
detectBump(messages)
