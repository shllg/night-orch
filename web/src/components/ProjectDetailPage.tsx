import { type ReactElement } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

import { formatTimestamp, truncate } from '../lib/format.js'
import {
  type ProjectRepoSummary,
  type ProjectsSnapshot,
} from '../types/dashboard.js'
import { ActionButton } from './ActionButton.js'
import {
  collectTags,
  describeRoleSelection,
  flag,
  formatBootstrap,
  formatCleanup,
  formatCommands,
  formatDedicatedEnv,
  formatLabelPresentation,
  formatList,
  formatSharedEnv,
  resolveRepoAuthDisplay,
} from './project-detail-helpers.js'

interface ProjectDetailPageProps {
  snapshot: ProjectsSnapshot | null
  repo: string
  isLoading: boolean
  operationsEnabled: boolean
  activeOperation: string | null
  onLabelsInit: (repo: string) => void
  onBack: () => void
}

export function ProjectDetailPage({
  snapshot,
  repo,
  isLoading,
  operationsEnabled,
  activeOperation,
  onLabelsInit,
  onBack,
}: ProjectDetailPageProps): ReactElement {
  const selectedProject = snapshot?.repos.find((candidate) => candidate.repo === repo) ?? null
  const authDisplay = selectedProject ? resolveRepoAuthDisplay(selectedProject, snapshot) : null

  if (isLoading && !snapshot) {
    return (
      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-5">
          <div className="skeleton h-5 w-44" />
          <div className="mt-4 grid gap-3">
            <div className="skeleton h-16 w-full" />
            <div className="skeleton h-16 w-full" />
            <div className="skeleton h-16 w-full" />
          </div>
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-6">
          <h2 className="card-title text-2xl font-semibold text-base-content">Project Details</h2>
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Project configuration is currently unavailable.</span>
          </div>
          <div className="mt-4">
            <ButtonWeb type="button" size="sm" tone="ghost" onClick={onBack}>
              Back to projects
            </ButtonWeb>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="card-title text-lg">Project Details</h2>
            <p className="text-xs text-base-content/60">
              Updated {formatTimestamp(snapshot.generatedAt)}
            </p>
          </div>
          <ButtonWeb type="button" size="sm" tone="ghost" onClick={onBack}>
            Back to projects
          </ButtonWeb>
        </div>

        {!selectedProject ? (
          <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Repository "{repo}" is not configured.</span>
          </div>
        ) : (
          <ProjectDetailBody
            selectedProject={selectedProject}
            workerProfiles={snapshot.workerProfiles}
            authDisplay={authDisplay}
            operationsEnabled={operationsEnabled}
            activeOperation={activeOperation}
            onLabelsInit={onLabelsInit}
          />
        )}
      </div>
    </section>
  )
}

function ProjectDetailBody({
  selectedProject,
  workerProfiles,
  authDisplay,
  operationsEnabled,
  activeOperation,
  onLabelsInit,
}: {
  selectedProject: ProjectRepoSummary
  workerProfiles: ProjectsSnapshot['workerProfiles']
  authDisplay: ReturnType<typeof resolveRepoAuthDisplay> | null
  operationsEnabled: boolean
  activeOperation: string | null
  onLabelsInit: (repo: string) => void
}): ReactElement {
  if (!authDisplay) {
    return <></>
  }

  return (
    <div className="mt-4 space-y-4">
      <section className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
        <h3 className="text-sm font-semibold text-base-content">{selectedProject.repo}</h3>
        <p className="mt-1 text-xs text-base-content/65">
          path {truncate(selectedProject.localPath, 140)}
        </p>
        <div className="mt-3 grid gap-2 text-xs text-base-content/80 sm:grid-cols-2">
          <p>forge {selectedProject.forge}</p>
          <p>base branch {selectedProject.baseBranch}</p>
          <p>branch prefix {selectedProject.branchPrefix}</p>
          <p>workflow {selectedProject.workflow ?? 'default'}</p>
          <p>max concurrency {selectedProject.maxConcurrentRuns}</p>
          <p>linked projects {formatList(selectedProject.linkedProjects)}</p>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Auth
          </h3>
          <p className="mt-2 text-xs text-base-content/85">token {authDisplay.tokenEnv}</p>
          <p className="mt-1 text-xs text-base-content/85">api {authDisplay.apiBaseUrl}</p>
          {authDisplay.apiMissing && (
            <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
              apiBaseUrl is required for Forgejo repositories.
            </p>
          )}
        </div>

        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Tools
          </h3>
          <div className="mt-2 space-y-1 text-xs text-base-content/85">
            <p>planner {describeRoleSelection(selectedProject, 'planner', workerProfiles)}</p>
            <p>coder {describeRoleSelection(selectedProject, 'coder', workerProfiles)}</p>
            <p>reviewer {describeRoleSelection(selectedProject, 'reviewer', workerProfiles)}</p>
            <p>mentions {formatList(selectedProject.defaults.prMentions)}</p>
          </div>
        </div>

        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Labels
          </h3>
          <div className="mt-2 space-y-1 text-xs text-base-content/85">
            <p>all tags {formatList(collectTags(selectedProject))}</p>
            <p>include {formatList(selectedProject.selectors.includeLabelsAny)}</p>
            <p>exclude {formatList(selectedProject.selectors.excludeLabelsAny)}</p>
            <p>
              lanes ready:{formatList(selectedProject.labels.ready)}
              {'  '}
              running:{selectedProject.labels.running}
              {'  '}
              review:{selectedProject.labels.reviewReady}
              {'  '}
              blocked:{selectedProject.labels.blocked}
            </p>
            {selectedProject.kanban && (
              <p>
                kanban trigger:{selectedProject.kanban.triggerLabel}
                {'  '}
                blocked:{selectedProject.kanban.labels.blocked}
              </p>
            )}
          </div>
          {!operationsEnabled && (
            <div className="alert alert-warning mt-3 text-xs">
              <span>Operations are disabled by server policy for this web instance.</span>
            </div>
          )}
          <fieldset disabled={!operationsEnabled} className={`mt-3 ${!operationsEnabled ? 'opacity-60' : ''}`}>
            <ActionButton
              busy={activeOperation === 'labels-init'}
              onClick={() => onLabelsInit(selectedProject.repo)}
              label="Bootstrap Labels"
            />
          </fieldset>
          <p className="mt-2 text-xs text-base-content/65">This action requires confirmation.</p>
        </div>

        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Execution
          </h3>
          <div className="mt-2 space-y-1 text-xs text-base-content/85">
            <p>verify {formatCommands(selectedProject.verify)}</p>
            <p>planning PRD dir {selectedProject.planning.prdDirectory}</p>
            <p>
              prompts planner:{flag(selectedProject.prompts.plannerSystem)}
              {'  '}
              coder:{flag(selectedProject.prompts.coderSystem)}
              {'  '}
              reviewer:{flag(selectedProject.prompts.reviewerSystem)}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Environment
          </h3>
          <div className="mt-2 space-y-1 text-xs text-base-content/85">
            <p>mode {selectedProject.environment?.defaultMode ?? 'shared (implicit default)'}</p>
            <p>bootstrap {formatBootstrap(selectedProject)}</p>
            <p>cleanup {formatCleanup(selectedProject)}</p>
            <p>shared {formatSharedEnv(selectedProject)}</p>
            <p>dedicated {formatDedicatedEnv(selectedProject)}</p>
          </div>
        </div>

        <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
            Merge Queue
          </h3>
          <div className="mt-2 space-y-1 text-xs text-base-content/85">
            <p>
              merge queue {selectedProject.mergeQueue.enabled ? 'enabled' : 'disabled'}
              {'  '}
              batch {selectedProject.mergeQueue.batchSize}
              {'  '}
              method {selectedProject.mergeQueue.mergeMethod}
              {'  '}
              approval {selectedProject.mergeQueue.requireApproval ? 'required' : 'optional'}
              {'  '}
              retryFlakyOnce {selectedProject.mergeQueue.retryFlakyOnce ? 'yes' : 'no'}
            </p>
            <p>staging branch {selectedProject.mergeQueue.stagingBranchPrefix}</p>
            <p>label presentation {formatLabelPresentation(selectedProject)}</p>
          </div>
        </div>
      </section>

      <details className="collapse collapse-arrow rounded-box border border-base-300/70 bg-base-100/65">
        <summary className="collapse-title py-3 text-sm font-semibold text-base-content">
          Raw Sanitized Config
        </summary>
        <div className="collapse-content pt-0">
          <pre className="overflow-x-auto rounded-md border border-base-300/70 bg-base-300/30 p-3 text-[11px] leading-relaxed text-base-content/85">
            {JSON.stringify(selectedProject, null, 2)}
          </pre>
        </div>
      </details>
    </div>
  )
}
