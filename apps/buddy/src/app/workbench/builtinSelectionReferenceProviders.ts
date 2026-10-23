import type { DesktopBrowserApi } from '@buddy-shared/browser/browserDesktopApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { SelectionReferenceLocateRequest, SelectionReferenceProvider, WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { isTextArtifactMimeType } from '@buddy-shared/artifacts/artifactApi'
import { buddyArtifactQuoteSchema, buddyBrowserQuoteSchema, buddyFileQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'
import { isMarkdownFile } from '@/shared/ui/files/fileDocumentPresentation'

export interface BuiltinSelectionReferenceOptions {
  controller: WorkbenchController
  openFile: (target: SpaceFileTarget, current: () => boolean) => Promise<string | null | undefined>
  resources: () => TaskResourcePanel
  independent: () => boolean
  ready: () => boolean
  locateFile: (target: SpaceFileTarget) => Promise<unknown>
  browser?: DesktopBrowserApi
  navigationVersion: () => number
}

function sourceOwner(scope: string | undefined, independent: boolean): string | null {
  return !independent && scope && /^(?:task|draft):/.test(scope) ? scope : null
}

function captureTabScope(options: BuiltinSelectionReferenceOptions, request: SelectionReferenceLocateRequest) {
  const resources = options.resources()
  let activeTabId = resources.activeTab.value?.id
  return {
    resources,
    current: () => request.current() && resources.activeTab.value?.id === activeTabId,
    acceptTab(id: string): boolean {
      const selected = resources.activeTab.value?.id
      if (!request.current() || (selected !== activeTabId && selected !== id))
        return false
      activeTabId = selected
      return true
    },
  }
}

function createFileProvider(options: BuiltinSelectionReferenceOptions): SelectionReferenceProvider {
  const captureSource: NonNullable<SelectionReferenceProvider['captureSource']> = (viewId) => {
    const view = options.controller.layout.views[viewId]
    if (!view || !['file', 'file-preview'].includes(view.resource.scheme))
      return null
    const tabId = typeof view.state.contextTabId === 'string' ? view.state.contextTabId : view.id
    const tab = options.resources().allTabs.value.find(tab => tab.id === tabId)
    if (view.location === 'context' && !tab)
      return null
    const independent = options.independent()
    return {
      identity: JSON.stringify([view.id, view.resource, view.state.mode, view.state.preview, independent, tab?.scope]),
      owner: sourceOwner(tab?.scope, independent),
    }
  }
  return {
    captureSource,
    resolveLocate(quote) {
      const parsed = buddyFileQuoteSchema.safeParse(quote)
      if (!parsed.success)
        return null
      const reference = parsed.data
      return async (request) => {
        const scope = captureTabScope(options, request)
        await options.locateFile(reference.source.file)
        if (!scope.current())
          return false
        const id = await options.openFile(reference.source.file, scope.current)
        const view = id ? options.controller.layout.views[id] : null
        if (!view)
          return false
        const tabId = typeof view.state.contextTabId === 'string' ? view.state.contextTabId : view.id
        if (!scope.acceptTab(tabId))
          return false
        options.controller.updateView(view.id, { state: { ...view.state, mode: reference.source.format === 'markdown' ? 'preview' : 'source' } })
        const identity = captureSource(view.id)?.identity
        return !!identity && await request.reveal(view.id, reference, () => scope.current() && captureSource(view.id)?.identity === identity)
      }
    },
  }
}

function createArtifactProvider(options: BuiltinSelectionReferenceOptions): SelectionReferenceProvider {
  const captureSource: NonNullable<SelectionReferenceProvider['captureSource']> = (viewId) => {
    const resources = options.resources()
    const tab = resources.allTabs.value.find(tab => tab.id === viewId && tab.kind === 'artifact')
    if (!tab || tab.kind !== 'artifact' || resources.activeTab.value?.id !== tab.id
      || tab.artifact.kind !== 'file' || (!isTextArtifactMimeType(tab.artifact.mimeType) && !isMarkdownFile(tab.artifact.name))) {
      return null
    }
    const independent = options.independent()
    return {
      identity: JSON.stringify([tab.id, tab.scope, tab.artifact, tab.viewMode, independent]),
      owner: sourceOwner(tab.scope, independent),
    }
  }
  return {
    captureSource,
    resolveLocate(quote) {
      const parsed = buddyArtifactQuoteSchema.safeParse(quote)
      if (!parsed.success)
        return null
      const reference = parsed.data
      return async (request) => {
        const scope = captureTabScope(options, request)
        const { resources } = scope
        const source = reference.source
        const artifact = resources.findArtifact(source.artifactId)
        if (!artifact || artifact.conversationId !== source.conversationId || artifact.runId !== source.runId || artifact.path !== source.path)
          return false
        await resources.openArtifact(artifact)
        const tab = resources.activeTab.value
        if (tab?.kind !== 'artifact' || tab.artifact.artifactId !== source.artifactId || !scope.acceptTab(tab.id))
          return false
        resources.setArtifactViewMode(tab.id, source.format === 'markdown' ? 'preview' : 'source')
        const identity = captureSource(tab.id)?.identity
        return !!identity && await request.reveal(tab.id, reference, () => scope.current() && captureSource(tab.id)?.identity === identity)
      }
    },
  }
}

function createBrowserProvider(options: BuiltinSelectionReferenceOptions): SelectionReferenceProvider {
  function identity(resources: TaskResourcePanel, tabId: string): string | null {
    const tab = resources.allTabs.value.find(tab => tab.id === tabId && tab.kind === 'browser')
    const state = resources.browserStates.value[tabId]
    if (!tab || !state || state.status !== 'ready')
      return null
    return JSON.stringify([tab.id, tab.scope, state.sessionId, state.pageId, state.documentVersion, state.url, options.independent()])
  }
  return {
    captureSource(viewId) {
      if (!viewId.startsWith('browser:'))
        return null
      const tabId = viewId.slice('browser:'.length)
      const resources = options.resources()
      const sourceIdentity = identity(resources, tabId)
      if (!sourceIdentity || resources.activeTab.value?.id !== tabId)
        return null
      const tab = resources.allTabs.value.find(tab => tab.id === tabId)
      return { identity: sourceIdentity, owner: sourceOwner(tab?.scope, options.independent()) }
    },
    resolveLocate(quote) {
      const parsed = buddyBrowserQuoteSchema.safeParse(quote)
      if (!parsed.success)
        return null
      const reference = parsed.data
      return async (request) => {
        const scope = captureTabScope(options, request)
        const { resources } = scope
        const tab = resources.tabs.value.find(tab => tab.kind === 'browser' && resources.browserStates.value[tab.id]?.sessionId === reference.source.sessionId)
        const sourceIdentity = tab && identity(resources, tab.id)
        if (!tab || !sourceIdentity)
          return false
        const located = await options.browser?.locateElement({ source: reference.source, element: reference.element, text: reference.text })
        if (!located || !scope.current() || identity(resources, tab.id) !== sourceIdentity)
          return false
        resources.selectTab(tab.id)
        if (!scope.acceptTab(tab.id))
          return false
        if (!resources.isOpen.value)
          resources.toggle()
        return request.current()
      }
    },
  }
}

export function registerBuiltinSelectionReferenceProviders(references: WorkbenchSelectionReferences, options: BuiltinSelectionReferenceOptions): () => void {
  const registrations = [
    references.registerProvider('builtin:file', createFileProvider(options)),
    references.registerProvider('builtin:artifact', createArtifactProvider(options)),
    references.registerProvider('builtin:browser', createBrowserProvider(options)),
  ]
  return () => registrations.forEach(dispose => dispose())
}
