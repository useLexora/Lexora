import type { z } from 'zod'
import type { ProductRecoveryItem } from '../../../shared/runtime/productRecovery'
import type { DesktopCommandOutcome, DesktopProductConnection } from './DesktopProductCommands'
import type { ProductOutboxRecord, ProductOutboxStore } from './ProductOutboxStore'
import { isDeepStrictEqual } from 'node:util'
import { buddyComposerDraftSchema } from '../../../shared/conversation/composerDraft'
import { productCommandIntents } from '../../../shared/productProtocol/methods'
import { productDraftSchema } from '../../../shared/productProtocol/queries'
import { isProductOutboxOwner, productOutboxRecordId, productRecoveryDigest } from './ProductOutboxStore'

type CurrentDraft = z.infer<typeof productDraftSchema>
export interface ProductRecoveryReview {
  record: ProductOutboxRecord
  item: ProductRecoveryItem
}

export function recoveryRecordIds(record: ProductOutboxRecord) {
  return [record.commandId, ...record.mergedCommandIds ?? []].map(commandId => productOutboxRecordId({ owner: record.owner, commandId }))
}

export function findRecoveryReview(reviews: ProductRecoveryReview[], id: string) {
  return reviews.find(review => review.item.id === id) ?? reviews.find(review => recoveryRecordIds(review.record).includes(id))
}

function failedSave(outcome: DesktopCommandOutcome) {
  const { record } = outcome
  const source = record.recovery
  if (record.method !== 'composerDrafts.save' || !source?.executionConfig || source.modelSelection === undefined
    || !(outcome.state === 'not_accepted' || (outcome.state === 'decided' && record.receipt?.decision === 'rejected'))) {
    return null
  }
  const result = productCommandIntents['composerDrafts.save'].safeParse(record.envelope?.intent)
  if (!result.success)
    return null
  const intent = result.data
  if (intent.draftId !== source.draftId || intent.expectedRevision !== source.editSequence
    || !isDeepStrictEqual(intent.executionConfig, source.executionConfig) || !isDeepStrictEqual(intent.modelSelection, source.modelSelection)
    || !isDeepStrictEqual(intent.participants ?? null, source.participants ?? null)) {
    return null
  }
  return intent
}

export async function reviewProductRecoveries(options: {
  outcomes: DesktopCommandOutcome[]
  connection: DesktopProductConnection | null
  assertCurrent: () => void
  readLocalDraft: (draftId: string) => Promise<unknown>
  outbox: ProductOutboxStore
}): Promise<ProductRecoveryReview[]> {
  const { connection, assertCurrent, outbox } = options
  const drafts = new Map<string, CurrentDraft | null>()
  const titles = new Map<string, string | undefined>()
  const groups = new Map<string, DesktopCommandOutcome[]>()
  for (const outcome of options.outcomes) {
    const { record } = outcome
    const input = connection && isProductOutboxOwner(record.owner, connection.identity) && failedSave(outcome)
    const key = input ? productRecoveryDigest({ owner: record.owner, input, recovery: record.recovery, state: outcome.state, errorCode: record.receipt?.errorCode }) : productOutboxRecordId(record)
    const group = groups.get(key)
    if (group)
      group.push(outcome)
    else
      groups.set(key, [outcome])
  }
  const reviews: ProductRecoveryReview[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.record.commandId.localeCompare(b.record.commandId))
    const first = group[0]!
    let record = first.record
    const id = productOutboxRecordId(record)
    const state = first.state === 'decided' ? record.receipt!.decision : first.state === 'connection_replaced' ? 'unknown' : first.state
    const item: ProductRecoveryItem = { id, state, method: record.method, commandId: record.commandId, createdAt: record.createdAt, conversationId: null, content: null, canRestore: false }
    if (!connection || !isProductOutboxOwner(record.owner, connection.identity) || first.state === 'trust_changed' || first.state === 'connection_replaced') {
      reviews.push({ record, item })
      continue
    }
    assertCurrent()
    if (group.length > 1)
      record = await outbox.mergeRecovery(record, group.slice(1).map(member => member.record))
    const source = record.recovery
    const input = failedSave(first)
    const draftId = source?.draftId ?? record.receipt?.target.draftId ?? null
    if (draftId && !drafts.has(draftId)) {
      const current = await connection.request('composerDrafts.get', { draftId }).then(value => productDraftSchema.nullable().parse(value)).catch(() => null)
      drafts.set(draftId, current?.draftId === draftId && current.ownerDeviceId === record.owner.deviceId && current.writable ? current : null)
    }
    const draft = draftId ? drafts.get(draftId) : null
    const scope = source?.scope
    if (input && scope && draft && isDeepStrictEqual(scope, draft.scope) && draft.content.kind === 'editable' && isDeepStrictEqual(input.content, draft.content.content)
      && isDeepStrictEqual(draft.executionConfig, input.executionConfig) && isDeepStrictEqual(draft.modelSelection, input.modelSelection)
      && isDeepStrictEqual(draft.participants ?? null, input.participants ?? null)
      && (input.spaceId === undefined || (draft.scope.kind === 'task' && draft.scope.spaceId === input.spaceId))
      && BigInt(draft.revision) >= BigInt(input.expectedRevision)) {
      // Portable quotes contain opaque references. Confirm the full local input, not a preview or transport projection.
      const saved = await options.readLocalDraft(draft.draftId).then(value => buddyComposerDraftSchema.parse(value)).catch(() => null)
      if (saved?.draftId === draft.draftId && String(saved.revision) === draft.revision && isDeepStrictEqual(saved.scope, draft.scope)
        && isDeepStrictEqual(saved.content, source!.content) && isDeepStrictEqual(saved.executionConfig, input.executionConfig)
        && isDeepStrictEqual(saved.modelSelection, input.modelSelection) && isDeepStrictEqual(saved.participants ?? null, input.participants ?? null)) {
        assertCurrent()
        await outbox.archive(record)
        continue
      }
    }
    const receiptTarget = record.method === 'composerDrafts.save' ? null : record.receipt?.target
    const conversationId = scope && 'conversationId' in scope ? scope.conversationId : receiptTarget?.conversationId ?? null
    const branchId = scope && 'branchId' in scope ? scope.branchId : receiptTarget?.branchId ?? null
    if (conversationId && !titles.has(conversationId)) {
      const task = await connection.request('conversations.get', { conversationId }).catch(() => null)
      titles.set(conversationId, task && typeof task === 'object' && 'id' in task && task.id === conversationId && 'title' in task && typeof task.title === 'string' ? task.title : undefined)
    }
    item.content = source?.content ?? null
    item.canRestore = (state === 'rejected' || state === 'not_accepted') && Boolean(source?.executionConfig)
    item.conversationId = conversationId
    item.branchId = branchId
    item.draftId = draftId
    item.sourceKind = conversationId ? 'conversation' : scope ? 'draft' : undefined
    item.sourceTitle = conversationId ? titles.get(conversationId) : undefined
    if (input && scope) {
      const { executionConfig, modelSelection, participants, expectedRevision, spaceId } = input
      item.draftInput = { executionConfig, modelSelection, participants, expectedRevision, spaceId, scope }
    }
    reviews.push({ record, item })
  }
  assertCurrent()
  return reviews
}
