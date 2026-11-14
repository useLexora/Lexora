import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { Router } from 'vue-router'
import type { TaskWorkspaceResource } from './taskResource'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { SplitDirection, WorkbenchView } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { buddyUserContentToText, hasBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { onScopeDispose } from 'vue'
import { userContentToChatComposerDocument } from '@/modules/prompt-input'
import { resourceKey } from '@/workbench/common/workbench'
import { parseTaskResource } from './taskResource'

export function useTaskNavigation(options: {
  api: LexoraDesktopApi
  controller: WorkbenchController
  pool: TaskWorkspacePool
  router: Router
  center: () => string
  chooseReplacement: () => Promise<'split' | 'discard' | 'cancel'>
  confirmDiscard: () => Promise<boolean>
  onError: (error: unknown) => void
}) {
  const { api, controller, pool, router, onError } = options
  const confirmedDraftCloses = new Set<string>()
  let navigationVersion = 0
  let routeVersion = 0
  onScopeDispose(router.beforeEach((to) => {
    if (to.path !== '/tasks') {
      navigationVersion += 1
      routeVersion += 1
      controller.cancelNavigation()
    }
  }))
  async function isDraftDirty(view: WorkbenchView): Promise<boolean> {
    if (view.resource.scheme !== 'draft')
      return false
    const task = pool.peek(view.resource)
    if (task)
      return task.workspace.composer.hasUnsentContent.value
    try {
      const draft = await api.localChat.composerDrafts.get(view.resource.id)
      return hasBuddyUserContent(draft.content)
    }
    catch {
      return false
    }
  }

  async function activateTask(resource: TaskWorkspaceResource, title: string, destination: { paneId?: string, direction?: SplitDirection, move?: boolean, signal?: AbortSignal, initialContent?: BuddyUserContentV1, prepareInput?: (viewId: string) => Promise<boolean> } = {}) {
    if (destination.signal?.aborted)
      return
    const targetPaneId = destination.paneId ?? options.center()
    const targetPane = controller.pane(targetPaneId)
    const currentViewId = targetPane?.view
    const currentView = currentViewId ? controller.layout.views[currentViewId] : null

    const isExistingTask = Object.values(controller.layout.views).some(view =>
      resourceKey(view.resource) === resourceKey(resource)
      && (view.location === 'main' || view.location === undefined),
    )

    const currentResource = currentView ? parseTaskResource(currentView.resource) : null
    if (!destination.direction && !isExistingTask && currentView && currentResource?.scheme === 'draft') {
      if (resource.scheme === 'draft' && !destination.initialContent && !destination.prepareInput) {
        const currentSpaceId = currentResource.data.spaceId
        const targetSpaceId = resource.data.spaceId
        if (currentSpaceId === targetSpaceId) {
          controller.focus(currentView.id)
          await router.push('/tasks')
          return
        }
      }
      if (await isDraftDirty(currentView)) {
        if (destination.initialContent || destination.prepareInput)
          return activateTask(resource, title, { ...destination, direction: 'right' })
        const action = await options.chooseReplacement()
        if (action === 'cancel') {
          controller.focus(currentView.id)
          return
        }
        if (action === 'split') {
          return activateTask(resource, title, { ...destination, direction: 'right' })
        }
        confirmedDraftCloses.add(currentView.id)
      }
    }

    navigationVersion += 1
    const version = routeVersion
    let id: string | null = null
    try {
      if (!destination.prepareInput)
        await router.push('/tasks')
      if (destination.signal?.aborted || version !== routeVersion)
        return
      id = await controller.open(resource, title, { paneId: targetPaneId, ...destination })
    }
    finally {
      if (currentView)
        confirmedDraftCloses.delete(currentView.id)
    }
    if (!id || (!destination.prepareInput && (destination.signal?.aborted || version !== routeVersion)))
      return
    let prepared = !destination.prepareInput
    try {
      const opened = controller.layout.views[id]
      if (!opened)
        return
      const task = await pool.open(opened.resource)
      if (!destination.signal?.aborted && controller.layout.views[id] && version === routeVersion) {
        if (destination.prepareInput) {
          prepared = await destination.prepareInput(id)
          if (!prepared)
            return
          await router.push('/tasks')
        }
        if (destination.initialContent) {
          task.workspace.composer.updateComposerContent(buddyUserContentToText(destination.initialContent), userContentToChatComposerDocument(destination.initialContent))
          await task.flushDrafts()
        }
      }
    }
    catch (error) {
      if (controller.layout.views[id])
        onError(error)
    }
    finally {
      if (!prepared && !isExistingTask && controller.layout.views[id]) {
        const view = controller.layout.views[id]!
        if (view.resource.scheme !== 'draft' || !await isDraftDirty(view)) {
          await controller.close(id)
          if (version === routeVersion && currentView && controller.layout.views[currentView.id])
            controller.focus(currentView.id)
        }
      }
    }
  }

  async function prepareClose(view: WorkbenchView): Promise<boolean> {
    if (view.resource.scheme !== 'draft' || confirmedDraftCloses.has(view.id) || !await isDraftDirty(view))
      return true
    if (!await options.confirmDiscard())
      return false
    confirmedDraftCloses.add(view.id)
    return true
  }

  return { activateTask, prepareClose, finishClose: (id: string) => confirmedDraftCloses.delete(id), get version() {
    return navigationVersion
  } }
}
