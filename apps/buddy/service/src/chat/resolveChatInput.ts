import type { SubmittedInput } from '../../../shared/conversation/submittedInput'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import { createHash } from 'node:crypto'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export interface TrustedSubmittedInput extends SubmittedInput {
  resourceOwnerId: string
}

export type ChatInputSource = { draftId: string, expectedRevision: number } | { snapshot: TrustedSubmittedInput }

export function inputResourceOwner(actorId: string, inputId: string): string {
  return `input-${createHash('sha256').update(JSON.stringify([actorId, inputId])).digest('hex')}`
}

export function resolveChatInput(source: ChatInputSource, drafts: Pick<ComposerDraftRepository, 'findById'>) {
  if ('snapshot' in source) {
    return { ...source.snapshot, draftId: source.snapshot.resourceOwnerId, revision: 0, commit: null, legacyResourceDraftId: source.snapshot.legacyResourceDraftId }
  }
  const draft = drafts.findById(source.draftId)
  if (!draft || draft.revision !== source.expectedRevision)
    throw new BuddyServiceError('DRAFT_CONFLICT')
  return { ...draft, commit: { draftId: source.draftId, expectedRevision: source.expectedRevision }, legacyResourceDraftId: undefined }
}
