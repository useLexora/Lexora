import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { WorkbenchView } from '@/workbench/common/workbench'
import type { ViewCloseDecision, ViewClosePlan, WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { TaskInputCleanup } from './TaskInputCleanup'

export function useTaskInputLifecycle(options: {
  api: LexoraDesktopApi
  controller: WorkbenchController
  persistence: WorkbenchPersistence
  pool: TaskWorkspacePool
  resources: () => TaskResourcePanel
  prepareFileClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision>
  onError: (error: unknown) => void
}) {
  const { controller, persistence, api } = options
  const cleanup = new TaskInputCleanup(controller, persistence, api.localChat.composerDrafts, id => options.resources().allTabs.value.some(tab => tab.scope === `draft:${id}`))
  async function prepareOwnedContext(draftId: string): Promise<ViewClosePlan | false> {
    const resources = options.resources()
    const tabIds = new Set(resources.allTabs.value.filter(tab => tab.scope === `draft:${draftId}`).map(tab => tab.id))
    const views = resources.mode.value === 'independent'
      ? []
      : Object.values(controller.layout.views)
          .filter(view => tabIds.has(view.id) || (typeof view.state.contextTabId === 'string' && tabIds.has(view.state.contextTabId)))
          .map(view => view.id)
    const closing = new Set(views)
    const decisions: ViewClosePlan[] = []
    for (const id of views) {
      const view = controller.layout.views[id]
      if (!view)
        continue
      const decision = await options.prepareFileClose(view, closing)
      if (!decision) {
        decisions.forEach(plan => plan.cancel?.())
        return false
      }
      if (typeof decision === 'object')
        decisions.push(decision)
    }
    let release = async () => {}
    return {
      views,
      cancel: () => decisions.forEach(plan => plan.cancel?.()),
      commit: () => {
        decisions.forEach(plan => plan.commit?.())
        release = resources.discardDraft(draftId)
        controller.layout.auxiliary.context = JSON.parse(JSON.stringify(resources.snapshot()))
      },
      complete: () => release(),
    }
  }

  async function prepareClose(view: WorkbenchView): Promise<ViewCloseDecision> {
    const task = await options.pool.open(view.resource)
    let prepared = false
    try {
      if (!await task.prepareClose())
        return false
      if (task.workspace.session.activeConversationId.value) {
        prepared = true
        return { cancel: task.cancelClose }
      }
      const draft = await api.localChat.composerDrafts.get(task.workspace.composer.draftId.value)
      if (draft.scope.kind !== 'task')
        return false
      const context = await prepareOwnedContext(draft.draftId)
      if (!context)
        return false
      prepared = true
      return {
        views: context.views,
        cancel: () => {
          context.cancel?.()
          task.cancelClose()
        },
        commit: () => {
          context.commit?.()
          cleanup.add({ draftId: draft.draftId, expectedRevision: draft.revision })
        },
        complete: async () => {
          await Promise.all([cleanup.flush(), context.complete?.()]).catch(options.onError)
        },
      }
    }
    finally {
      if (!prepared)
        task.cancelClose()
    }
  }

  return { prepareClose, restore: (hasLayout: boolean) => cleanup.restore(hasLayout).catch(options.onError), flush: () => cleanup.flush() }
}
