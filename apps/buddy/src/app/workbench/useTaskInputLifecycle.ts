import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { WorkbenchView } from '@/workbench/common/workbench'
import type { ViewCloseDecision, WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { buddyComposerDraftDiscardSchema } from '@buddy-shared/conversation/composerDraft'
import { TaskInputCleanup } from './TaskInputCleanup'

export function useTaskInputLifecycle(options: {
  api: LexoraDesktopApi
  controller: WorkbenchController
  persistence: WorkbenchPersistence
  pool: TaskWorkspacePool
  resources: () => TaskResourcePanel
  onError: (error: unknown) => void
}) {
  const { controller, persistence, api } = options
  const cleanup = new TaskInputCleanup(controller, persistence, api.localChat.composerDrafts, id => options.resources().allTabs.value.some(tab => tab.scope === `draft:${id}`))

  async function prepareClose(view: WorkbenchView): Promise<ViewCloseDecision> {
    const task = await options.pool.open(view.resource)
    const releaseWorkspace = options.pool.acquire(view.resource)
    const cancel = () => {
      try {
        task.cancelClose()
      }
      finally { releaseWorkspace() }
    }
    let prepared = false
    try {
      if (!await task.prepareClose())
        return false
      if (task.workspace.session.activeConversationId.value) {
        prepared = true
        return { cancel, complete: releaseWorkspace }
      }
      const draft = await api.localChat.composerDrafts.get(task.workspace.composer.draftId.value)
      if (draft.scope.kind !== 'task')
        return false
      const resources = options.resources()
      const tabIds = new Set(resources.allTabs.value.filter(tab => tab.scope === `draft:${draft.draftId}`).map(tab => tab.id))
      const views = resources.mode.value === 'independent'
        ? []
        : Object.values(controller.layout.views)
            .filter(view => tabIds.has(view.id) || (typeof view.state.contextTabId === 'string' && tabIds.has(view.state.contextTabId)))
            .map(view => view.id)
      prepared = true
      return {
        views,
        cancel,
        prepareAuxiliary: (current) => {
          const pending = Array.isArray(current.pendingInputDiscards)
            ? current.pendingInputDiscards.flatMap((value) => {
                const parsed = buddyComposerDraftDiscardSchema.safeParse(value)
                return parsed.success && parsed.data.draftId !== draft.draftId ? [parsed.data] : []
              })
            : []
          return { ...current, pendingInputDiscards: [...pending, { draftId: draft.draftId, expectedRevision: draft.revision }] }
        },
        complete: async ({ revision }) => {
          try {
            await persistence.flushThrough({ layoutRevision: revision })
            const release = resources.discardDraft(draft.draftId)
            controller.setAuxiliary('context', JSON.parse(JSON.stringify(resources.snapshot())))
            await persistence.flush()
            const results = await Promise.allSettled([cleanup.flush(), release()])
            const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (failures.length)
              throw new AggregateError(failures, 'Task input cleanup failed')
          }
          finally { releaseWorkspace() }
        },
      }
    }
    finally {
      if (!prepared)
        cancel()
    }
  }

  return { prepareClose, restore: (hasLayout: boolean) => cleanup.restore(hasLayout).catch(options.onError), flush: () => cleanup.flush() }
}
