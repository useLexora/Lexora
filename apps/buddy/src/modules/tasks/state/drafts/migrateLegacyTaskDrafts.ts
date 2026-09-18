import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { JSONContent } from '@tiptap/core'
import { chatComposerDocumentToUserContent, createChatComposerContentFromText } from '@/modules/prompt-input'
import { normalizeLegacyDraftScopeKey, parseDraftScopeKey } from '../../model/drafts/draftScope'

export async function migrateLegacyTaskDrafts(api: { workspaceState: LexoraDesktopApi['localChat']['workspaceState'], composerDrafts: Pick<LexoraDesktopApi['localChat']['composerDrafts'], 'open'> }, conversations: readonly LocalConversationSummary[]): Promise<void> {
  const setting = await api.workspaceState.read()
  if (!setting || !('drafts' in setting.value))
    return
  for (const draft of setting.value.drafts) {
    const target = normalizeLegacyDraftScopeKey(draft, conversations)
    if (!target || draft.attachments.length)
      throw new Error('Legacy draft requires explicit recovery')
    const previous = parseDraftScopeKey(target)
    const scope = previous.kind === 'global' || previous.kind === 'space'
      ? { kind: 'task' as const, draftId: draft.draftId, spaceId: previous.kind === 'space' ? previous.spaceId : null }
      : previous
    const restored = await api.composerDrafts.open({
      draftId: draft.draftId,
      scope,
      initialContent: chatComposerDocumentToUserContent(draft.composerContent as JSONContent | null ?? createChatComposerContentFromText(draft.content)),
      initialExecutionConfig: { approvalPolicy: draft.approvalPolicy, executionProfile: draft.executionProfile },
      initialModelSelection: null,
    })
    if (restored.draftId !== draft.draftId)
      throw new Error('Legacy draft conflicts with an existing draft')
  }
  await api.workspaceState.write({ activeConversationId: setting.value.activeConversationId, spaceId: setting.value.spaceId })
}
