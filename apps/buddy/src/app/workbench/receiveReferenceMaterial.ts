import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { SelectionReferenceRequest, WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'

export type ReferenceMaterial
  = | { kind: 'quote', quote: BuddyResourceQuote }
    | { kind: 'source', source: BuddyComposerSource }
    | { kind: 'file', name: string, mimeType: string, base64: string }

export async function receiveReferenceMaterial(options: {
  references: WorkbenchSelectionReferences
  controller: WorkbenchController
  pool: TaskWorkspacePool
  scope: Omit<SelectionReferenceRequest, 'quote'>
  targetId: string
  material: ReferenceMaterial
  current: () => boolean
}): Promise<boolean> {
  const { references, controller, pool, scope, targetId, material } = options
  const captured = scope.targets.find(target => target.id === targetId)
  const valid = () => options.current() && references.captureSource(scope.viewId)?.identity === scope.sourceIdentity
    && !!captured && references.targets().some(target => target.id === targetId && target.identity === captured.identity)
  if (!valid())
    return false
  const view = controller.layout.views[targetId]
  const task = view && pool.peek(view.resource)
  if (!task)
    return false
  if (material.kind === 'quote') {
    const result = references.add({ ...scope, quote: material.quote }, targetId)
    return (result === 'added' || result === 'duplicate') && await task.flushDrafts()
  }
  const composer = task.workspace.composer
  const draftId = composer.draftId.value
  let resourceId: string | null
  if (material.kind === 'source') {
    resourceId = await composer.selectSource(material.source, draftId)
  }
  else {
    const bytes = Uint8Array.from(atob(material.base64), char => char.charCodeAt(0))
    resourceId = await composer.importFileSnapshot(new File([bytes], material.name, { type: material.mimeType }))
  }
  if (!resourceId || !valid() || composer.draftId.value !== draftId)
    return false
  const content = composer.composerContent.value
  composer.updateComposerContent(composer.draft.value, {
    ...content,
    attrs: { ...content.attrs, panelResourceIds: [...new Set([...content.attrs?.panelResourceIds ?? [], resourceId])] },
  })
  return task.flushDrafts()
}
