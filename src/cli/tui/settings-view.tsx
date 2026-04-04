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
        <Text dimColor>No curated runtime settings available.</Text>
      </Box>
    )
  }

  const clampedIndex = Math.max(0, Math.min(settings.length - 1, selectedIndex))
  const selected = settings[clampedIndex]!

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="cyan">Runtime Settings</Text>
      <Text dimColor>Use j/k to select, +/- to adjust numeric values, space to toggle booleans, u to clear override.</Text>

      <Box flexDirection="column" marginTop={1}>
        {settings.map((setting, index) => {
          const selectedRow = index === clampedIndex
          const override = setting.overrideValue === null ? '-' : formatSettingValue(setting.overrideValue)
          const line = `${setting.key} | effective=${formatSettingValue(setting.effectiveValue)} | override=${override} | source=${setting.source}`
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
        <Text>
          base={formatSettingValue(selected.baseValue)} override={
            selected.overrideValue === null ? '-' : formatSettingValue(selected.overrideValue)
          } effective={formatSettingValue(selected.effectiveValue)}
        </Text>
      </Box>
    </Box>
  )
}

function formatSettingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}
