import type { ProductRecoveryItem } from '@buddy-shared/runtime/productRecovery'
import type { TaskDraftRestoration } from '../../contracts'
import type { DraftRestorationConflict } from './typing'
import { buddyComposerDraftScopeKey } from '@buddy-shared/conversation/composerDraft'
import { parseDraftScopeKey } from '../../model/drafts/draftScope'
import { createDraftValueFingerprint } from '../../model/drafts/draftValueFingerprint'

interface SourceTask {
  conversationId: string | null
  branchId: string | null
  spaceId?: string | null
}

export function matchesDraftRecovery(item: ProductRecoveryItem, conflict: DraftRestorationConflict, source: SourceTask): boolean {
  const { local } = conflict
  if (item.method !== 'composerDrafts.save' || !['rejected', 'not_accepted'].includes(item.state)
    || !item.canRestore || !item.content || !item.draftInput
    || item.draftId !== local.draftId || local.revision === null || item.draftInput.expectedRevision !== String(local.revision)
    || conflict.targetKey !== local.targetKey || buddyComposerDraftScopeKey(item.draftInput.scope) !== local.targetKey) {
    return false
  }
  const scope = parseDraftScopeKey(local.targetKey)
  const original = item.draftInput.scope
  const matchesSource = original.kind === 'task'
    ? item.sourceKind === 'draft' && !source.conversationId && !item.conversationId && original.draftId === local.draftId
    && source.spaceId === original.spaceId && (item.draftInput.spaceId === undefined || item.draftInput.spaceId === original.spaceId)
    : item.sourceKind === 'conversation' && 'conversationId' in scope && item.draftInput.spaceId === undefined
      && scope.conversationId === source.conversationId && scope.branchId === source.branchId
      && item.conversationId === source.conversationId && item.branchId === source.branchId
  return matchesSource && createDraftValueFingerprint({ content: item.content, ...item.draftInput }) === createDraftValueFingerprint({
    content: local.content,
    executionConfig: { executionProfile: local.executionProfile, approvalPolicy: local.approvalPolicy },
    modelSelection: local.modelSelection,
    participants: local.participants,
  })
}

export function createDraftConflictResolver(options: {
  conflict: TaskDraftRestoration['conflict']
  source: () => SourceTask
  resolve: TaskDraftRestoration['resolveConflict']
  runtime: {
    listRecovery: () => Promise<ProductRecoveryItem[]>
    acknowledgeRecovery: (id: string) => Promise<void>
  }
  onError: (error: unknown) => void
}): TaskDraftRestoration['resolveConflict'] {
  return async (key, choice, reviewed) => {
    const conflict = options.conflict.value
    const source = options.source()
    if (!conflict || conflict.targetKey !== key || (reviewed && !matchesDraftRecovery(reviewed, conflict, source)))
      return false
    const candidates = reviewed
      ? [reviewed]
      : options.runtime.listRecovery().catch((error) => {
          options.onError(error)
          return []
        })
    if (!await options.resolve(key, choice))
      return false
    const matched = (await candidates).filter(item => matchesDraftRecovery(item, conflict, source))
    if (matched.length === 1) {
      try {
        await options.runtime.acknowledgeRecovery(matched[0]!.id)
      }
      catch (error) {
        options.onError(error)
        return !reviewed
      }
    }
    return true
  }
}
