#!/usr/bin/env node

/**
 * Generate release notes from commit messages since the last tag.
 *
 * Groups commits by category and outputs markdown suitable for a GitHub release.
 */

import { execFileSync } from 'node:child_process'

const CATEGORY_LABELS = {
  FEATURE: 'Features',
  FIX: 'Bug Fixes',
  REFACTOR: 'Refactoring',
  CHORE: 'Maintenance',
  INTERNAL: 'Internal',
  DOCS: 'Documentation',
  TEST: 'Testing',
}

const CATEGORY_RE = /^\[([A-Z]+)\]\s*/

function getCommitsSinceLastTag() {
  let range
  try {
    const lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    range = `${lastTag}..HEAD`
  } catch {
    range = 'HEAD'
  }

  const log = execFileSync('git', ['log', range, '--pretty=format:%s (%h)'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

  return log.length > 0 ? log.split('\n') : []
}

function generateNotes(messages) {
  const grouped = {}
  const uncategorized = []

  for (const msg of messages) {
    const match = CATEGORY_RE.exec(msg)
    if (match?.[1]) {
      const category = match[1]
      const text = msg.replace(CATEGORY_RE, '')
      const label = CATEGORY_LABELS[category] ?? category
      if (!grouped[label]) grouped[label] = []
      grouped[label].push(text)
    } else {
      uncategorized.push(msg)
    }
  }

  const sections = []

  const order = ['Features', 'Bug Fixes', 'Refactoring', 'Maintenance', 'Internal', 'Documentation', 'Testing']
  for (const label of order) {
    if (grouped[label]) {
      sections.push(`### ${label}\n${grouped[label].map((c) => `- ${c}`).join('\n')}`)
      delete grouped[label]
    }
  }

  for (const [label, commits] of Object.entries(grouped)) {
    sections.push(`### ${label}\n${commits.map((c) => `- ${c}`).join('\n')}`)
  }

  if (uncategorized.length > 0) {
    sections.push(`### Other\n${uncategorized.map((c) => `- ${c}`).join('\n')}`)
  }

  process.stdout.write(sections.join('\n\n') + '\n')
}

const messages = getCommitsSinceLastTag()
generateNotes(messages)
