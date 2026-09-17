import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'

export type ArtifactViewMode = 'preview' | 'source'
export type ContextPanelScope = `task:${string}` | `draft:${string}` | 'independent'

interface ContextTabSource {
  scope: ContextPanelScope
  source?: ContextPanelSource
}

export interface TaskArtifactContextTab extends ContextTabSource {
  artifact: LocalArtifact
  id: string
  kind: 'artifact'
  label: string
  viewMode: ArtifactViewMode
}

export interface TaskChangesContextTab extends ContextTabSource {
  branchId: string | null
  revision: string
  changeSet: LocalChangeSetSummary | null
  conversationId: string
  id: string
  kind: 'changes'
}

export interface TaskBrowserContextTab extends ContextTabSource {
  conversationId: string | null
  id: string
  kind: 'browser'
  browserKey?: string
}

export interface TaskFilesContextTab extends ContextTabSource {
  id: string
  kind: 'files'
  target: SpaceFileTarget
  rootName: string
}

export interface ContextPanelTab {
  id: string
  title: string
  icon: 'file' | 'folder' | 'changes' | 'browser'
  fileName?: string
}

export type TaskContextTab = TaskArtifactContextTab
  | TaskBrowserContextTab
  | TaskChangesContextTab
  | TaskFilesContextTab

export function spaceTaskArtifactTabs(
  outputs: ReadonlyArray<LocalRunOutput>,
): ReadonlyArray<TaskArtifactContextTab> {
  const artifacts = new Map<string, LocalArtifact>()
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      artifacts.set(artifact.artifactId, artifact)
    }
  }
  return [...artifacts.values()].map(artifact => ({
    artifact,
    scope: taskContextPanelScope(artifact.conversationId),
    id: artifactTabId(artifact.artifactId),
    kind: 'artifact',
    label: artifact.name,
    viewMode: 'preview',
  }))
}

export function artifactTabId(artifactId: string): string {
  return `artifact:${artifactId}`
}

export function isBrowserArtifact(
  artifact: Pick<LocalArtifact, 'kind' | 'mimeType' | 'name'>,
): boolean {
  return artifact.kind === 'file'
    && artifact.mimeType === 'text/html'
    && /\.html?$/i.test(artifact.name)
}

export function spaceTaskBrowserTab(
  conversationId: string | null,
): TaskBrowserContextTab | null {
  return conversationId
    ? {
        conversationId,
        scope: taskContextPanelScope(conversationId),
        id: browserTabId(conversationId),
        kind: 'browser',
      }
    : null
}

export function browserTabId(conversationId: string | null, browserKey?: string): string {
  const prefix = conversationId === null ? 'browser:manual' : `browser:${conversationId}`
  return browserKey ? `${prefix}:${browserKey}` : prefix
}

export function changeTabId(conversationId: string): string {
  return `changes:${conversationId}`
}

export function taskContextPanelScope(conversationId: string): ContextPanelScope {
  return `task:${conversationId}`
}

export function contextTabSource(tab: TaskContextTab | null): ContextPanelSource | null {
  const source = tab?.kind === 'artifact' ? tab.artifact : tab?.kind === 'changes' ? tab.changeSet ?? tab.source : tab?.source
  return source ? { conversationId: source.conversationId, runId: source.runId } : null
}
