import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'

import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createChatComposerContentFromText } from '@/modules/prompt-input'
import { createBuddyUserContent } from '../../../../../../shared/conversation/buddyUserContent'
import { useChatDrafts } from '../useChatDrafts'

describe('useChatDrafts', () => {
  it('owns a complete editor value per strict Draft scope', () => {
    const { drafts, targetKey } = createFixture()
    const globalId = drafts.draftId.value
    drafts.updateComposerContent('global text', createChatComposerContentFromText('global text'))
    drafts.setPermissionSettings({ approvalPolicy: 'manual', executionProfile: 'read_only' })
    targetKey.value = 'space:space-1'
    const spaceId = drafts.draftId.value
    drafts.updateComposerContent('space text', createChatComposerContentFromText('space text'))
    targetKey.value = 'global'

    expect(drafts.draftId.value).toBe(globalId)
    expect(drafts.draft.value).toBe('global text')
    expect(drafts.approvalPolicy.value).toBe('manual')
    expect(drafts.executionProfile.value).toBe('read_only')
    expect(drafts.load('space:space-1')).toMatchObject({ draftId: spaceId })
    expect(drafts.snapshot('space:space-1').content).toEqual(createBuddyUserContent('space text'))
  })

  it('clears and retargets exactly the persisted snapshot acknowledged by Runtime', () => {
    const { drafts, targetKey } = createFixture()
    drafts.updateComposerContent('sent', createChatComposerContentFromText('sent'))
    const submitted = drafts.snapshot('global')
    drafts.confirmOpen(submitted, runtimeDraft({
      content: submitted.content,
      draftId: submitted.draftId,
      revision: 0,
    }))
    const editorKey = drafts.editorKey.value

    expect(drafts.acknowledgeSend({
      committedRevision: 1,
      draftId: submitted.draftId,
      sourceRevision: 0,
    }, 'conversation:conversation-1:branch-1')).toBe(true)
    targetKey.value = 'conversation:conversation-1:branch-1'

    expect(drafts.draftId.value).toBe(submitted.draftId)
    expect(drafts.draft.value).toBe('')
    expect(drafts.editorKey.value).not.toBe(editorKey)
    expect(drafts.snapshot(targetKey.value).revision).toBe(1)
  })

  it.each([false, true])('retargets an independent draft without recreating its committed identity, edited during send: %s', (edited) => {
    const targetKey = ref('draft:independent')
    const drafts = useChatDrafts({ targetKey: computed(() => targetKey.value), onChange: () => {} })
    drafts.updateComposerContent('sent', createChatComposerContentFromText('sent'))
    const submitted = drafts.snapshot(targetKey.value)
    drafts.confirmOpen(submitted, runtimeDraft({ content: submitted.content, draftId: submitted.draftId, revision: 0 }))
    if (edited)
      drafts.updateComposerContent('next message', createChatComposerContentFromText('next message'))
    expect(drafts.acknowledgeSend({ committedRevision: 1, draftId: submitted.draftId, sourceRevision: 0 }, 'conversation:one:branch')).toBe(!edited)
    expect(drafts.draftId.value).toBe('independent')
    expect(drafts.listSnapshots().map(snapshot => [snapshot.targetKey, snapshot.draftId])).toEqual([['conversation:one:branch', 'independent']])
    targetKey.value = 'conversation:one:branch'
    expect(drafts.draft.value).toBe(edited ? 'next message' : '')
    expect(drafts.snapshot(targetKey.value).revision).toBe(1)
  })

  it('confirms equal model selections despite different property insertion order', () => {
    const { drafts } = createFixture()
    const modelSelection = {
      modelId: 'model-1',
      providerId: 'provider-1',
      reasoning: null,
      serviceTier: null,
    }
    drafts.setModelSelection({
      serviceTier: modelSelection.serviceTier,
      reasoning: modelSelection.reasoning,
      providerId: modelSelection.providerId,
      modelId: modelSelection.modelId,
    })
    const submitted = drafts.snapshot('global')
    drafts.confirmSave(submitted, {
      ...runtimeDraft({ content: submitted.content, draftId: submitted.draftId, revision: 1 }),
      modelSelection,
    })

    expect(drafts.isPersisted(drafts.snapshot('global'))).toBe(true)
  })

  it.each(['model', 'provider', 'reasoning', 'serviceTier', 'content', 'resourceOrder'] as const)(
    'preserves a real %s change while an earlier save is being confirmed',
    (change) => {
      const { drafts } = createFixture()
      const modelSelection = {
        modelId: 'model-1',
        providerId: 'provider-1',
        reasoning: null,
        serviceTier: null,
      }
      drafts.setModelSelection(modelSelection)
      drafts.setUserContent({ ...createBuddyUserContent('original'), panelResourceIds: ['resource-1', 'resource-2'] })
      const submitted = drafts.snapshot('global')
      switch (change) {
        case 'model':
          drafts.setModelSelection({ ...modelSelection, modelId: 'model-2' })
          break
        case 'provider':
          drafts.setModelSelection({ ...modelSelection, providerId: 'provider-2' })
          break
        case 'reasoning':
          drafts.setModelSelection({ ...modelSelection, reasoning: 'high' })
          break
        case 'serviceTier':
          drafts.setModelSelection({ ...modelSelection, serviceTier: 'priority' })
          break
        case 'content':
          drafts.setUserContent(createBuddyUserContent('edited while saving'))
          break
        case 'resourceOrder':
          drafts.setUserContent({ ...submitted.content, panelResourceIds: ['resource-2', 'resource-1'] })
          break
      }
      const edited = drafts.snapshot('global')
      drafts.confirmSave(submitted, {
        ...runtimeDraft({ content: submitted.content, draftId: submitted.draftId, revision: 1 }),
        modelSelection,
      })

      expect(drafts.isPersisted(drafts.snapshot('global'))).toBe(false)
      expect(drafts.snapshot('global')).toMatchObject({
        content: edited.content,
        modelSelection: edited.modelSelection,
      })
    },
  )

  it('drops every branch Draft owned by a deleted conversation', async () => {
    const { drafts, targetKey } = createFixture()
    targetKey.value = 'conversation:conversation-1:branch-1'
    const first = drafts.draftId.value
    targetKey.value = 'conversation:conversation-1:branch-2'
    const second = drafts.draftId.value

    await drafts.discardConversation('conversation-1')

    expect(drafts.listSnapshots().map(snapshot => snapshot.draftId)).not.toContain(first)
    expect(drafts.listSnapshots().map(snapshot => snapshot.draftId)).not.toContain(second)
  })

  it.each([false, true])('moves only the committed edit Draft to its branch when navigation is %s', (navigate) => {
    const { drafts, targetKey } = createFixture()
    targetKey.value = 'conversation:conversation-1:branch-1'
    drafts.updateComposerContent('ordinary pending input', createChatComposerContentFromText('ordinary pending input'))
    const ordinaryDraft = drafts.snapshot(targetKey.value)
    const editKey = 'message-edit:conversation-1:branch-1:user-1'
    drafts.beginIsolated(editKey, createBuddyUserContent('edited message'))
    const submitted = drafts.snapshot(editKey)
    drafts.confirmOpen(submitted, runtimeDraft({
      content: submitted.content,
      draftId: submitted.draftId,
      revision: 2,
      scope: {
        branchId: 'branch-1',
        conversationId: 'conversation-1',
        kind: 'message_edit',
        userMessageId: 'user-1',
      },
    }), true)

    const otherFollowup = 'message-followup:another-conversation:another-branch:another-answer'
    if (navigate) {
      targetKey.value = 'conversation:another-conversation:another-branch'
      drafts.resumeIsolated(otherFollowup)
      drafts.updateComposerContent('new target input', null)
    }

    expect(drafts.completeIsolated({
      committedRevision: 3,
      draftId: submitted.draftId,
      sourceRevision: 2,
    }, 'conversation:conversation-1:branch-2', editKey)).toBe(true)
    if (navigate) {
      expect(drafts.targetKey.value).toBe(otherFollowup)
      expect(drafts.draft.value).toBe('new target input')
    }
    targetKey.value = 'conversation:conversation-1:branch-2'
    expect(drafts.draft.value).toBe('')
    targetKey.value = 'conversation:conversation-1:branch-1'
    expect(drafts.draftId.value).toBe(ordinaryDraft.draftId)
    expect(drafts.draft.value).toBe('ordinary pending input')
  })
})

function createFixture() {
  const targetKey = ref('global')
  const drafts = useChatDrafts({
    onChange: vi.fn(),
    targetKey: computed(() => targetKey.value),
  })
  return { drafts, targetKey }
}

function runtimeDraft(
  input: Pick<LocalComposerDraft, 'content' | 'draftId' | 'revision'> & Partial<Pick<LocalComposerDraft, 'scope'>>,
): LocalComposerDraft {
  return {
    ...input,
    executionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    modelSelection: null,
    scope: input.scope ?? { kind: 'global' },
    updatedAt: '2026-09-06T00:00:00.000Z',
  }
}
