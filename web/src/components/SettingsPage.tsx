import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'
import { ModalWeb } from '../../../src/components/modal/modal.web.js'
import type { RuntimeSettingSnapshot, RuntimeSettingValue } from '../types/dashboard.js'
import { PushNotificationSettings } from './PushNotificationSettings.js'

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
  const [selectedSettingKey, setSelectedSettingKey] = useState<string | null>(null)
  const [overwriteEnabled, setOverwriteEnabled] = useState<Record<string, boolean>>({})

  const selectedSetting = useMemo(
    () => settings.find((setting) => setting.key === selectedSettingKey) ?? null,
    [selectedSettingKey, settings],
  )
  const selectedDraft = selectedSetting
    ? (drafts[selectedSetting.key] ?? formatSettingValue(selectedSetting.effectiveValue))
    : ''
  const selectedOverwriteEnabled = selectedSetting
    ? (overwriteEnabled[selectedSetting.key] ?? selectedSetting.overrideValue !== null)
    : false
  const selectedBusy = selectedSetting
    ? isSettingBusy(activeOperation, selectedSetting.key)
    : false
  const selectedReadOnly = selectedSetting ? !selectedSetting.mutable : false

  useEffect(() => {
    setOverwriteEnabled(
      Object.fromEntries(
        settings.map((setting) => [setting.key, setting.overrideValue !== null]),
      ),
    )

    if (selectedSettingKey && !settings.some((setting) => setting.key === selectedSettingKey)) {
      setSelectedSettingKey(null)
    }
  }, [selectedSettingKey, settings])

  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-6 lg:p-8">
        <h2 className="card-title text-2xl font-semibold capitalize text-base-content">settings</h2>
        <p className="max-w-3xl text-sm text-base-content/75">
          Runtime overrides are stored in SQLite and applied on top of YAML/default values.
        </p>
        <p className="text-xs text-base-content/60">Last refresh: {generatedAt ?? '-'}</p>

        <PushNotificationSettings />

        {isLoading ? (
          <p className="text-sm text-base-content/70">Loading settings…</p>
        ) : settings.length === 0 ? (
          <p className="text-sm text-base-content/70">No runtime settings available.</p>
        ) : (
          <ul className="mt-2 grid gap-3">
            {settings.map((setting) => (
              <li key={setting.key}>
                <button
                  type="button"
                  className="group w-full rounded-box border border-base-300/80 bg-base-100/60 p-4 text-left transition hover:border-info/40 hover:bg-base-100/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-info/70"
                  onClick={() => {
                    setSelectedSettingKey(setting.key)
                  }}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-base-content">{setting.label}</span>
                        <span
                          className={`badge badge-xs ${setting.source === 'override' ? 'badge-info' : 'badge-ghost'}`}
                        >
                          {setting.source === 'override' ? 'overwritten' : 'default/yaml'}
                        </span>
                        {!setting.mutable ? <span className="badge badge-xs badge-warning">read-only</span> : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] text-base-content/55">{setting.key}</p>
                      <p className="mt-2 text-sm text-base-content/75">{setting.description}</p>
                    </div>

                    <div className="shrink-0 rounded-lg border border-base-300/80 bg-base-100/60 px-3 py-2 sm:min-w-[150px] sm:text-right">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/55">Applied</p>
                      <p className="mt-1 font-mono text-sm font-semibold text-base-content">
                        {formatSettingValue(setting.effectiveValue)}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ModalWeb
        open={selectedSetting !== null}
        title={selectedSetting?.label}
        description={selectedSetting?.details}
        widthClassName="max-w-2xl"
        onClose={() => {
          setSelectedSettingKey(null)
        }}
        actions={selectedSetting ? (
          <>
            <ButtonWeb
              type="button"
              tone="ghost"
              onClick={() => {
                setSelectedSettingKey(null)
              }}
            >
              close
            </ButtonWeb>
            <ButtonWeb
              type="button"
              tone={selectedOverwriteEnabled ? 'info' : 'neutral'}
              onClick={() => {
                if (!selectedSetting) {
                  return
                }
                if (!selectedSetting.mutable) {
                  return
                }
                if (selectedOverwriteEnabled) {
                  onApply(selectedSetting.key)
                  return
                }
                onClear(selectedSetting.key)
              }}
              disabled={selectedBusy || selectedReadOnly}
            >
              {selectedReadOnly
                ? 'read-only'
                : selectedBusy
                ? 'saving...'
                : selectedOverwriteEnabled
                  ? 'apply override'
                  : 'clear override'}
            </ButtonWeb>
          </>
        ) : null}
      >
        {selectedSetting ? (
          <div className="mt-4 space-y-4">
            <dl className="grid gap-2 rounded-box border border-base-300/70 bg-base-200/50 p-3 text-sm sm:grid-cols-2">
              <SettingFact label="Night-orch default" value={formatSettingValue(selectedSetting.defaultValue)} />
              <SettingFact
                label="YAML value"
                value={
                  selectedSetting.hasYamlValue && selectedSetting.yamlValue !== null
                    ? formatSettingValue(selectedSetting.yamlValue)
                    : 'Not set'
                }
              />
              <SettingFact label="Effective value" value={formatSettingValue(selectedSetting.effectiveValue)} />
              <SettingFact
                label="Current override"
                value={
                  selectedSetting.overrideValue === null
                    ? 'None'
                    : formatSettingValue(selectedSetting.overrideValue)
                }
              />
            </dl>

            <label className="flex items-center gap-3 rounded-box border border-base-300/70 bg-base-200/45 p-3">
              <input
                type="checkbox"
                className="checkbox checkbox-sm checkbox-info"
                checked={selectedOverwriteEnabled}
                disabled={selectedBusy || selectedReadOnly}
                onChange={(event) => {
                  setOverwriteEnabled((current) => ({
                    ...current,
                    [selectedSetting.key]: event.target.checked,
                  }))
                }}
              />
              <div>
                <p className="text-sm font-medium text-base-content">Overwrite this value</p>
                <p className="text-xs text-base-content/65">
                  {selectedSetting.mutable
                    ? 'Disable to use YAML/default value. Enable to set a DB runtime override.'
                    : 'This key is read-only at runtime and cannot be overridden from settings.'}
                </p>
              </div>
            </label>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
                Override value
              </p>
              {selectedSetting.type === 'boolean' ? (
                <select
                  className="select select-bordered w-full max-w-xs font-mono"
                  value={normalizeBooleanDraft(selectedDraft)}
                  onChange={(event) => {
                    onDraftChange(selectedSetting.key, event.target.value)
                  }}
                  disabled={!selectedOverwriteEnabled || selectedBusy || selectedReadOnly}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : selectedSetting.type === 'number' ? (
                <input
                  className="input input-bordered w-full max-w-xs font-mono"
                  type="number"
                  value={selectedDraft}
                  min={selectedSetting.min}
                  max={selectedSetting.max}
                  step={selectedSetting.step}
                  onChange={(event) => {
                    onDraftChange(selectedSetting.key, event.target.value)
                  }}
                  disabled={!selectedOverwriteEnabled || selectedBusy || selectedReadOnly}
                />
              ) : selectedSetting.options && selectedSetting.options.length > 0 ? (
                <select
                  className="select select-bordered w-full max-w-xs font-mono"
                  value={selectedDraft}
                  onChange={(event) => {
                    onDraftChange(selectedSetting.key, event.target.value)
                  }}
                  disabled={!selectedOverwriteEnabled || selectedBusy || selectedReadOnly}
                >
                  {selectedSetting.options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                  {selectedSetting.allowNull ? (
                    <option value="null">null</option>
                  ) : null}
                </select>
              ) : selectedSetting.type === 'json' ? (
                <textarea
                  className="textarea textarea-bordered min-h-[160px] w-full font-mono text-xs"
                  value={selectedDraft}
                  onChange={(event) => {
                    onDraftChange(selectedSetting.key, event.target.value)
                  }}
                  disabled={!selectedOverwriteEnabled || selectedBusy || selectedReadOnly}
                />
              ) : (
                <input
                  className="input input-bordered w-full max-w-xs font-mono"
                  type="text"
                  value={selectedDraft}
                  onChange={(event) => {
                    onDraftChange(selectedSetting.key, event.target.value)
                  }}
                  disabled={!selectedOverwriteEnabled || selectedBusy || selectedReadOnly}
                />
              )}
            </div>
          </div>
        ) : null}
      </ModalWeb>
    </section>
  )
}

function SettingFact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-base-content/55">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-base-content">{value}</dd>
    </div>
  )
}

function isSettingBusy(activeOperation: string | null, key: string): boolean {
  return activeOperation === `setting:set:${key}` || activeOperation === `setting:clear:${key}`
}

function formatSettingValue(value: RuntimeSettingValue): string {
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return String(value)
}

function normalizeBooleanDraft(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized === 'false' ? 'false' : 'true'
}
