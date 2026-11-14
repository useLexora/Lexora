import type { WorkbenchView } from '@/workbench/common/workbench'
import type { ViewCloseDecision, WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { resourceKey } from '@/workbench/common/workbench'

export function createFileClosePreparation(options: {
  controller: WorkbenchController
  copies: WorkingCopyService
  persistence: WorkbenchPersistence
  confirm: (title: string, actions: { discard: () => void, save: () => Promise<boolean> }) => Promise<boolean>
  onError: (error: unknown) => void
}) {
  const { controller, copies, persistence } = options
  return async (view: WorkbenchView, closing: ReadonlySet<string> = new Set()): Promise<ViewCloseDecision> => {
    const first = [...closing].find(id => resourceKey(controller.layout.views[id]?.resource ?? { scheme: '', id: '', data: {} }) === resourceKey(view.resource))
    if (first && first !== view.id)
      return true
    if (Object.values(controller.layout.views).some(other => other.id !== view.id && !closing.has(other.id) && resourceKey(other.resource) === resourceKey(view.resource)))
      return true
    const current = copies.get(view.resource)
    if (!current)
      return true
    if (!current.dirty)
      return { validate: () => copies.isCurrent(current) && !copies.dirty(view.resource) }
    let decision: ViewCloseDecision = false
    const accepted = await options.confirm(view.title, {
      discard() {
        const accepted = copies.get(view.resource)
        decision = accepted
          ? {
              validate: () => copies.isCurrent(accepted),
              complete: async ({ revision }) => {
                if (!copies.isCurrent(accepted))
                  throw new Error('WORKING_COPY_CHANGED_DURING_CLOSE')
                copies.discard(view.resource)
                await persistence.flushThrough({ layoutRevision: revision, backupRevision: persistence.backups.revision })
              },
            }
          : true
      },
      async save() {
        try {
          const result = await copies.save(view.resource)
          if ((result.status !== 'saved' && result.status !== 'unchanged') || result.dirtyAfter)
            return false
          const saved = copies.get(view.resource)!
          await persistence.flushThrough(persistence.capture())
          decision = { validate: () => copies.isCurrent(saved) && !copies.dirty(view.resource) }
          return true
        }
        catch (error) {
          options.onError(error)
          return false
        }
      },
    })
    return accepted ? decision : false
  }
}
