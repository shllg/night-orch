import React from 'react'
import { Box, Text, useInput } from 'ink'
import type Database from 'better-sqlite3'

interface ActionsBarProps {
  db: Database.Database
  onAction: (action: string, args?: Record<string, unknown>) => void
}

export function ActionsBar({ db: _db, onAction }: ActionsBarProps): React.ReactElement {
  useInput((input, key) => {
    if (input === 'r') onAction('retry')
    if (input === 'b') onAction('rebase')
    if (input === 's') onAction('sync')
    if (input === 'c') onAction('cleanup')
    if (input === 'p') onAction('poll')
    if (key.escape || input === 'q') onAction('quit')
  })

  return (
    <Box marginTop={1}>
      <Text color="gray">
        [r]etry  [b]rebase  [s]ync  [c]leanup  [p]oll  [q]uit
      </Text>
    </Box>
  )
}
