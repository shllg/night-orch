import type { SettingDefinition } from '../registry.js'
import { booleanSetting, numberSetting, stringSetting } from '../registry.js'

export function observabilityDefinitions(): SettingDefinition[] {
  return [
    booleanSetting({
      key: 'metrics.enabled',
      label: 'Metrics Enabled',
      description: 'Enable Prometheus metrics export.',
      details: 'Turns `/metrics` export on or off.',
      defaultValue: true,
      yamlPath: ['metrics', 'enabled'],
    }),
    numberSetting({
      key: 'metrics.port',
      label: 'Metrics Port',
      description: 'TCP port for Prometheus metrics endpoint.',
      details: 'Port used when metrics exporter is enabled.',
      defaultValue: 9090,
      yamlPath: ['metrics', 'port'],
      integer: true,
      min: 1,
      max: 65535,
      step: 1,
    }),
    stringSetting({
      key: 'metrics.host',
      label: 'Metrics Host',
      description: 'Bind address for Prometheus metrics endpoint.',
      details: 'Network interface/address used by metrics exporter.',
      defaultValue: '0.0.0.0',
      yamlPath: ['metrics', 'host'],
      minLength: 1,
    }),

    booleanSetting({
      key: 'observability.agentStreaming',
      label: 'Agent Streaming',
      description: 'Enable in-flight agent event streaming to TUI/Web.',
      details: 'Turns live agent event streaming on or off for terminal and web views.',
      defaultValue: true,
      yamlPath: ['observability', 'agentStreaming'],
    }),
    numberSetting({
      key: 'observability.eventRetention',
      label: 'Event Retention',
      description: 'Maximum in-memory event backlog per run/session.',
      details: 'Controls event retention window for stream history.',
      defaultValue: 1000,
      yamlPath: ['observability', 'eventRetention'],
      integer: true,
      min: 100,
      max: 10000,
      step: 100,
    }),
    booleanSetting({
      key: 'observability.sessionLogs',
      label: 'Session Logs Enabled',
      description: 'Persist interactive agent session logs to disk.',
      details: 'If enabled, interactive session logs are written and retained.',
      defaultValue: true,
      yamlPath: ['observability', 'sessionLogs'],
    }),
    numberSetting({
      key: 'observability.sessionLogRetention',
      label: 'Session Log Retention (days)',
      description: 'Retention period for interactive session logs.',
      details: 'Session logs older than this many days may be deleted by cleanup.',
      defaultValue: 7,
      yamlPath: ['observability', 'sessionLogRetention'],
      integer: true,
      min: 1,
      step: 1,
    }),
  ]
}
