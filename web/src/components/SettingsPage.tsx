import { type ReactElement } from 'react'
import type { RuntimeSettingSnapshot } from '../types/dashboard.js'

interface SettingsPageProps {
  settings: RuntimeSettingSnapshot[]
  generatedAt: string | null
  isLoading: boolean
  activeOperation: string | null
  drafts: Record<string, string>
  onDraftChange: (key: string, value: string) => void
  onApply: (key: string) => void
  onClear: (key: string) => void
}

export function SettingsPage({
  settings,
  generatedAt,
  isLoading,
  activeOperation,
  drafts,
  onDraftChange,
  onApply,
  onClear,
}: SettingsPageProps): ReactElement {
  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-6 sm:p-8">
        <h2 className="card-title text-2xl font-semibold capitalize text-base-content">settings</h2>
        <p className="max-w-3xl text-sm text-base-content/75">
          Runtime overrides are stored in SQLite and applied on top of YAML/default values.
        </p>
        <p className="text-xs text-base-content/60">
          Last refresh: {generatedAt ?? '-'}
        </p>

        {isLoading ? (
          <p className="text-sm text-base-content/70">Loading settings…</p>
        ) : settings.length === 0 ? (
          <p className="text-sm text-base-content/70">No curated settings available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Base</th>
                  <th>Override</th>
                  <th>Effective</th>
                  <th>Value</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {settings.map((setting) => {
                  const draft = drafts[setting.key] ?? formatSettingValue(setting.effectiveValue)
                  const rowBusy = activeOperation === `setting:set:${setting.key}` || activeOperation === `setting:clear:${setting.key}`

                  return (
                    <tr key={setting.key}>
                      <td>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs">{setting.key}</span>
                          <span className="text-xs text-base-content/60">{setting.label}</span>
                        </div>
                      </td>
                      <td className="font-mono text-xs">{formatSettingValue(setting.baseValue)}</td>
                      <td className="font-mono text-xs">
                        {setting.overrideValue === null ? '-' : formatSettingValue(setting.overrideValue)}
                      </td>
                      <td className="font-mono text-xs">
                        {formatSettingValue(setting.effectiveValue)}
                        <span className="ml-2 badge badge-ghost badge-xs">{setting.source}</span>
                      </td>
                      <td>
                        {setting.type === 'boolean' ? (
                          <select
                            className="select select-bordered select-xs w-28"
                            value={normalizeBooleanDraft(draft)}
                            onChange={(event) => onDraftChange(setting.key, event.target.value)}
                            disabled={rowBusy}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            className="input input-bordered input-xs w-32 font-mono"
                            type="number"
                            value={draft}
                            min={setting.min}
                            max={setting.max}
                            step={setting.step}
                            onChange={(event) => onDraftChange(setting.key, event.target.value)}
                            disabled={rowBusy}
                          />
                        )}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="btn btn-xs btn-info"
                            onClick={() => onApply(setting.key)}
                            disabled={rowBusy}
                          >
                            apply
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            onClick={() => onClear(setting.key)}
                            disabled={rowBusy}
                          >
                            clear
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function formatSettingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function normalizeBooleanDraft(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized === 'false' ? 'false' : 'true'
}
