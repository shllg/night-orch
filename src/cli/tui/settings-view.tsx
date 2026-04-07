import React from 'react'
import { Box, Text } from 'ink'
import type { RuntimeSettingSnapshot } from '../../settings/runtime.js'

interface SettingsViewProps {
  settings: RuntimeSettingSnapshot[]
  selectedIndex: number
}

export function SettingsView({
  settings,
  selectedIndex,
}: SettingsViewProps): React.ReactElement {
  if (settings.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color="cyan">Settings</Text>
        <Text dimColor>No runtime settings available.</Text>
      </Box>
    )
  }

  const clampedIndex = Math.max(0, Math.min(settings.length - 1, selectedIndex))
  const selected = settings[clampedIndex]!

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="cyan">Runtime Settings</Text>
      <Text dimColor>Use j/k to select, +/- for numbers, space for booleans, u to clear override (read-only keys cannot be changed).</Text>

      <Box flexDirection="column" marginTop={1}>
        {settings.map((setting, index) => {
          const selectedRow = index === clampedIndex
          const override = setting.overrideValue === null ? '-' : formatSettingValue(setting.overrideValue)
          const mode = setting.mutable ? 'mutable' : 'read-only'
          const line = `${setting.key} | effective=${formatSettingValue(setting.effectiveValue)} | override=${override} | source=${setting.source} | ${mode}`
          return (
            <Text key={setting.key} color={selectedRow ? 'white' : 'gray'} inverse={selectedRow}>
              {selectedRow ? '▸ ' : '  '}
              {line}
            </Text>
          )
        })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color="white">Selected</Text>
        <Text>{selected.label}</Text>
        <Text dimColor>{selected.description}</Text>
        <Text dimColor>{selected.mutable ? 'mutable' : 'read-only at runtime'}</Text>
        <Text>
          base={formatSettingValue(selected.baseValue)} override={
            selected.overrideValue === null ? '-' : formatSettingValue(selected.overrideValue)
          } effective={formatSettingValue(selected.effectiveValue)}
        </Text>
      </Box>
    </Box>
  )
}

function formatSettingValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return JSON.stringify(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  return JSON.stringify(value)
}
