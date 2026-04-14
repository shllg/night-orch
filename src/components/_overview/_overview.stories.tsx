import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { AlertWeb } from '../alert/alert.web.js'
import { BadgeWeb } from '../badge/badge.web.js'
import { ButtonWeb } from '../button/button.web.js'
import { CollapsibleWeb } from '../collapsible/collapsible.web.js'
import { LogLineWeb } from '../log-line/log-line.web.js'
import { NavDockWeb } from '../nav-dock/nav-dock.web.js'
import { NavMenuWeb } from '../nav-menu/nav-menu.web.js'
import { NumberInputWeb } from '../number-input/number-input.web.js'
import { SelectWeb } from '../select/select.web.js'
import { TabsWeb } from '../tabs/tabs.web.js'
import { TextAreaWeb } from '../textarea/textarea.web.js'
import { TextInputWeb } from '../text-input/text-input.web.js'
import { useState } from 'react'
import type { Size, Tone } from '../shared-types.js'

const meta = {
  title: '00 — Overview/Design System',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const ALL_TONES: Tone[] = [
  'neutral',
  'primary',
  'secondary',
  'accent',
  'info',
  'success',
  'warning',
  'error',
  'ghost',
]

const ALL_SIZES: Size[] = ['xs', 'sm', 'md', 'lg']

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-base-content/55">{eyebrow}</p>
        <h2 className="text-2xl font-semibold text-base-content">{title}</h2>
      </header>
      <div className="rounded-2xl border border-base-300/60 bg-base-200/40 p-4 sm:p-6 backdrop-blur">
        {children}
      </div>
    </section>
  )
}

function TabsPreview(): ReactNode {
  const [active, setActive] = useState('overview')
  return (
    <TabsWeb
      variant="box"
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'runs', label: 'Runs' },
        { id: 'settings', label: 'Settings' },
      ]}
      activeId={active}
      onChange={setActive}
      ariaLabel="Dashboard sections"
    />
  )
}

function Dot({ ch }: { ch: string }): ReactNode {
  return (
    <span
      className="flex size-5 items-center justify-center rounded-full bg-base-100/30 text-[10px] font-semibold uppercase"
      aria-hidden
    >
      {ch}
    </span>
  )
}

function NavPreview(): ReactNode {
  const [active, setActive] = useState('issues')
  const items = [
    { id: 'issues', label: 'issues', icon: <Dot ch="i" /> },
    { id: 'stats', label: 'stats', icon: <Dot ch="s" /> },
    { id: 'projects', label: 'projects', icon: <Dot ch="p" /> },
    { id: 'settings', label: 'settings', icon: <Dot ch="c" /> },
  ].map((it) => ({ ...it, isActive: it.id === active, onClick: () => { setActive(it.id) } }))

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div className="rounded-xl border border-base-300/60 bg-base-200/45 px-3 py-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-base-content/55">NavMenu (sidebar)</p>
        <NavMenuWeb items={items} ariaLabel="Pages" />
      </div>
      <div className="max-w-[390px] rounded-xl border border-base-300/60 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-base-content/55">NavDock (mobile)</p>
        <NavDockWeb items={items} ariaLabel="Pages" />
      </div>
    </div>
  )
}

function Board({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-orch-admin px-4 py-8 text-base-content sm:px-8 sm:py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-10">{children}</div>
    </div>
  )
}

const TONE_SWATCH: Record<Tone, string> = {
  neutral: 'bg-neutral',
  primary: 'bg-primary',
  secondary: 'bg-secondary',
  accent: 'bg-accent',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  ghost: 'bg-base-300/40 border border-dashed border-base-content/30',
}

function ColorSwatch({ tone }: { tone: Tone }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className={`h-14 w-14 rounded-xl shadow-inner ${TONE_SWATCH[tone]}`} aria-hidden />
      <span className="text-xs font-medium text-base-content/85">{tone}</span>
    </div>
  )
}

export const DesignSystem: Story = {
  render: () => (
    <Board>
      <header className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-base-content/55">
          night-orch
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-base-content">Design system</h1>
        <p className="max-w-2xl text-sm text-base-content/70">
          Mobile-first, dark-only primitives built on DaisyUI v5. This overview is the board used to
          iterate on tokens and components. Every primitive under <code>src/components/</code> has
          its own story tree in the sidebar.
        </p>
      </header>

      <Section eyebrow="Tokens" title="Tones">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5 md:grid-cols-9">
          {ALL_TONES.map((tone) => (
            <ColorSwatch key={tone} tone={tone} />
          ))}
        </div>
      </Section>

      <Section eyebrow="Tokens" title="Size scale">
        <div className="flex flex-wrap items-end gap-3">
          {ALL_SIZES.map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <ButtonWeb tone="primary" size={size}>
                {size}
              </ButtonWeb>
              <span className="text-[11px] text-base-content/60">btn-{size === 'md' ? '(default)' : size}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="Surfaces" title="Cards and panels">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-base-300/70 bg-base-100/60 p-5 shadow-panel backdrop-blur">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">Surface</p>
            <h3 className="mt-1 text-lg font-semibold">Base panel</h3>
            <p className="mt-2 text-sm text-base-content/70">
              Used for primary content containers. Subtle border, translucent background.
            </p>
          </div>
          <div className="rounded-xl border border-primary/40 bg-primary/10 p-5 shadow-panel backdrop-blur">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Accent surface</p>
            <h3 className="mt-1 text-lg font-semibold">Highlighted panel</h3>
            <p className="mt-2 text-sm text-base-content/70">
              For active selections, onboarding nudges, or primary-tone states.
            </p>
          </div>
        </div>
      </Section>

      <Section eyebrow="Typography" title="Text scale">
        <div className="space-y-2">
          <p className="text-4xl font-semibold tracking-tight">Heading / 4xl semibold</p>
          <p className="text-2xl font-semibold">Section / 2xl semibold</p>
          <p className="text-lg font-semibold">Card title / lg semibold</p>
          <p className="text-sm">Body / sm</p>
          <p className="text-xs uppercase tracking-[0.18em] text-base-content/55">Eyebrow / xs uppercase</p>
          <p className="font-mono text-xs text-base-content/70">code / mono xs</p>
        </div>
      </Section>

      <Section eyebrow="Patterns" title="Live primitives">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Buttons</p>
            <div className="flex flex-wrap gap-2">
              <ButtonWeb tone="primary">Primary</ButtonWeb>
              <ButtonWeb tone="info" variant="outline">Outline</ButtonWeb>
              <ButtonWeb tone="ghost">Ghost</ButtonWeb>
              <ButtonWeb tone="error">Destructive</ButtonWeb>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Badges</p>
            <div className="flex flex-wrap gap-2">
              <BadgeWeb tone="primary">primary</BadgeWeb>
              <BadgeWeb tone="info">info</BadgeWeb>
              <BadgeWeb tone="success">success</BadgeWeb>
              <BadgeWeb tone="warning">warning</BadgeWeb>
              <BadgeWeb tone="error">error</BadgeWeb>
              <BadgeWeb tone="neutral" variant="outline">outline</BadgeWeb>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Text input / Number</p>
            <div className="grid gap-2">
              <TextInputWeb placeholder="owner/repo" fullWidth size="sm" />
              <TextInputWeb placeholder="error state" tone="error" fullWidth size="sm" />
              <NumberInputWeb defaultValue={3} min={0} max={10} step={1} size="sm" fullWidth />
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Select</p>
            <SelectWeb
              fullWidth
              size="sm"
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
                { value: 'gemini', label: 'Gemini' },
              ]}
              defaultValue="claude"
              ariaLabel="Agent"
            />
          </div>
          <div className="space-y-3 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Textarea</p>
            <TextAreaWeb placeholder="Describe the change…" fullWidth rows={3} />
          </div>
          <div className="space-y-3 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Tabs</p>
            <TabsPreview />
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Alerts</p>
            <div className="grid gap-2">
              <AlertWeb tone="info" title="Heads up">Neutral status message.</AlertWeb>
              <AlertWeb tone="warning" title="Budget at 80%">Approaching monthly cap.</AlertWeb>
              <AlertWeb tone="error" role="alert" title="Push failed">Run 42 could not push its branch.</AlertWeb>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Collapsible</p>
            <CollapsibleWeb title="Run details" defaultOpen>
              Logs, metadata, and checkpoints go here.
            </CollapsibleWeb>
          </div>
          <div className="space-y-3 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">LogLine / stream row</p>
            <div className="rounded-box border border-base-300/70 bg-base-100/80 p-3">
              <LogLineWeb timestamp="14:03:20.001" source="system" message="phase_start: plan" />
              <LogLineWeb timestamp="14:03:21.400" source="agent" role="claude" message="Reading issue body and discussing approach." />
              <LogLineWeb timestamp="14:03:22.552" source="system" message="phase_complete: plan (1.55s)" />
            </div>
          </div>
          <div className="space-y-3 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">Navigation</p>
            <NavPreview />
          </div>
        </div>
      </Section>

      <Section eyebrow="Components" title="Primitive index">
        <ul className="grid gap-1.5 text-sm text-base-content/80 sm:grid-cols-2">
          <li>• Alert — <code className="text-base-content/55">src/components/alert/</code></li>
          <li>• Badge — <code className="text-base-content/55">src/components/badge/</code></li>
          <li>• Button — <code className="text-base-content/55">src/components/button/</code></li>
          <li>• Card — <code className="text-base-content/55">src/components/card/</code></li>
          <li>• Collapsible — <code className="text-base-content/55">src/components/collapsible/</code></li>
          <li>• IssueRow — <code className="text-base-content/55">src/components/issue-row/</code></li>
          <li>• LogLine — <code className="text-base-content/55">src/components/log-line/</code></li>
          <li>• Modal — <code className="text-base-content/55">src/components/modal/</code></li>
          <li>• NavDock — <code className="text-base-content/55">src/components/nav-dock/</code></li>
          <li>• NavMenu — <code className="text-base-content/55">src/components/nav-menu/</code></li>
          <li>• NumberInput — <code className="text-base-content/55">src/components/number-input/</code></li>
          <li>• Select — <code className="text-base-content/55">src/components/select/</code></li>
          <li>• Tabs — <code className="text-base-content/55">src/components/tabs/</code></li>
          <li>• TextArea — <code className="text-base-content/55">src/components/textarea/</code></li>
          <li>• TextInput — <code className="text-base-content/55">src/components/text-input/</code></li>
        </ul>
        <p className="mt-4 text-xs text-base-content/55">
          All primitives shipped. Layout work follows next.
        </p>
      </Section>
    </Board>
  ),
}
