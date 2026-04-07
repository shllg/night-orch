import { z } from 'zod'
import {
  CostPricingModelSchema,
  WorkerProfileSchema,
} from '../../config/schema.js'
import type { JsonValue, SettingDefinition, SettingValue } from '../registry.js'
import {
  jsonSetting,
  numberSetting,
  stringSetting,
  validateJsonSettingShape,
} from '../registry.js'

const CostPricingModelsOverrideSchema = z.record(CostPricingModelSchema)
const WorkerProfilesOverrideSchema = z.record(WorkerProfileSchema)

export function securityDefinitions(): SettingDefinition[] {
  return [
    numberSetting({
      key: 'security.maxChangedFiles',
      label: 'Max Changed Files',
      description: 'Diff guard threshold for changed files.',
      details: 'Runs are blocked when changed-file count exceeds this threshold.',
      defaultValue: 50,
      yamlPath: ['security', 'maxChangedFiles'],
      integer: true,
      min: 1,
      step: 1,
    }),
    numberSetting({
      key: 'security.maxChangedLines',
      label: 'Max Changed Lines',
      description: 'Diff guard threshold for changed lines.',
      details: 'Runs are blocked when changed-line count exceeds this threshold.',
      defaultValue: 5000,
      yamlPath: ['security', 'maxChangedLines'],
      integer: true,
      min: 1,
      step: 50,
    }),
    numberSetting({
      key: 'security.maxDailyCostUsd',
      label: 'Daily Cost Budget (USD)',
      description: 'Maximum allowed spend per UTC day before new runs are blocked.',
      details: 'Sets the global daily spend cap for pay-per-use mode.',
      defaultValue: 50,
      yamlPath: ['security', 'maxDailyCostUsd'],
      integer: false,
      min: 0.01,
      step: 1,
    }),
    numberSetting({
      key: 'security.maxCostPerRunUsd',
      label: 'Per-Run Cost Budget (USD)',
      description: 'Maximum allowed spend for a single run before it is blocked.',
      details: 'Sets the per-issue run cost ceiling for pay-per-use mode.',
      defaultValue: 10,
      yamlPath: ['security', 'maxCostPerRunUsd'],
      integer: false,
      min: 0.01,
      step: 0.5,
    }),

    stringSetting({
      key: 'cost.model',
      label: 'Cost Model',
      description: 'Cost enforcement model.',
      details: 'pay-per-use enforces spend caps; subscription treats USD as advisory.',
      defaultValue: 'pay-per-use',
      yamlPath: ['cost', 'model'],
      options: ['pay-per-use', 'subscription'],
    }),
    stringSetting({
      key: 'cost.pricing.defaultModel',
      label: 'Default Pricing Model',
      description: 'Fallback model key for pricing lookups.',
      details: 'Used when a worker profile does not specify a pricing model.',
      defaultValue: 'default',
      yamlPath: ['cost', 'pricing', 'defaultModel'],
      minLength: 1,
    }),
    jsonSetting({
      key: 'cost.pricing.models',
      label: 'Pricing Models Map',
      description: 'Model-specific pricing table.',
      details: 'Record keyed by model name with token/minute pricing values.',
      defaultValue: {},
      yamlPath: ['cost', 'pricing', 'models'],
      normalize: (value) => validateJsonSettingShape(value, CostPricingModelsOverrideSchema, 'cost.pricing.models'),
    }),

    jsonSetting({
      key: 'workerProfiles',
      label: 'Worker Profiles',
      description: 'Global worker profile definitions.',
      details: 'Record of worker profile definitions keyed by profile name.',
      defaultValue: {},
      yamlPath: ['workerProfiles'],
      sensitive: true,
      normalize: (value) => validateJsonSettingShape(value, WorkerProfilesOverrideSchema, 'workerProfiles'),
      sanitizeForDisplay: (value) => redactWorkerProfiles(value),
    }),
  ]
}

function redactWorkerProfiles(value: JsonValue): SettingValue {
  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([profileName, profile]) => {
      if (!isRecord(profile) || !isRecord(profile['env'])) {
        return [profileName, profile]
      }

      const redactedEnv = Object.fromEntries(
        Object.keys(profile['env']).map((envKey) => [envKey, '[redacted]']),
      )
      return [profileName, { ...profile, env: redactedEnv }]
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
