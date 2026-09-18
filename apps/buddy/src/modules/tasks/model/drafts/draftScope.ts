import type { BuddyComposerDraftScope } from '@buddy-shared/conversation/composerDraft'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'

import type { LocalWorkspaceDraft } from '@buddy-shared/conversation/workspaceApi'

export function createDraftScopeKey(selection: {
  draftKey?: string
  branchId: string | null
  conversationId: string | null
  spaceId: string | null
}): string {
  if (selection.conversationId && selection.branchId)
    return `conversation:${selection.conversationId}:${selection.branchId}`
  if (selection.draftKey)
    return `draft:${selection.draftKey}`
  return selection.spaceId ? `space:${selection.spaceId}` : 'global'
}

export function parseDraftScopeKey(targetKey: string): BuddyComposerDraftScope {
  if (targetKey === 'global')
    return { kind: 'global' }
  const parts = targetKey.split(':')
  if (parts[0] === 'draft' && parts.length === 2 && parts[1])
    return { kind: 'task', draftId: parts[1], spaceId: null }
  if (parts[0] === 'space' && parts.length === 2 && parts[1])
    return { kind: 'space', spaceId: parts[1] }
  if (parts[0] === 'conversation' && parts.length === 3 && parts[1] && parts[2]) {
    return {
      branchId: parts[2],
      conversationId: parts[1],
      kind: 'conversation_branch',
    }
  }
  if (
    (parts[0] === 'message-edit' || parts[0] === 'message-followup')
    && parts.length === 4
    && parts[1]
    && parts[2]
    && parts[3]
  ) {
    return {
      branchId: parts[2],
      conversationId: parts[1],
      ...(parts[0] === 'message-edit'
        ? { kind: 'message_edit' as const, userMessageId: parts[3] }
        : { kind: 'message_followup' as const, assistantMessageId: parts[3] }),
    }
  }
  throw new Error('Invalid Composer draft scope')
}

export function normalizeLegacyDraftScopeKey(
  draft: LocalWorkspaceDraft,
  conversations: ReadonlyArray<LocalConversationSummary>,
): string | null {
  if (draft.targetKey === 'global' || draft.targetKey.startsWith('space:'))
    return draft.targetKey
  const parts = draft.targetKey.split(':')
  if (parts[0] !== 'conversation' || !parts[1])
    return null
  if (parts[2])
    return draft.targetKey
  const branchId = conversations.find(conversation => conversation.id === parts[1])?.activeBranchId
  return branchId ? `conversation:${parts[1]}:${branchId}` : null
}
