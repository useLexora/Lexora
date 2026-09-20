import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalComposerDraft, LocalComposerDraftOpen, LocalComposerDraftSave } from '@buddy-shared/conversation/composerApi'
import type { BuddyComposerDraftScope } from '@buddy-shared/conversation/composerDraft'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'

import { buddyComposerDraftModelSelectionSchema } from '@buddy-shared/conversation/composerDraft'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { chatComposerDocumentToUserContent, createChatComposerContentFromText } from '@/modules/prompt-input'
import { useChatSession } from '@/modules/tasks/state/conversations/useChatSession'
import { useChatDrafts } from '@/modules/tasks/state/drafts/useChatDrafts'
import { useTaskWorkspacePersistence } from '../useTaskWorkspacePersistence'

describe('workspace Draft persistence', () => {
  it.each(['ready', 'open'] as const)('retries a failed initial %s without writing an empty Draft or confirming exit', async (operation) => {
    let failing = true
    const failInitially = async () => {
      if (failing)
        throw new Error('Runtime unavailable')
    }
    const fixture = await createFixture({
      beforeOpen: operation === 'open' ? failInitially : undefined,
      beforeReady: operation === 'ready' ? failInitially : undefined,
      confirmedContent: 'saved before restart',
      hydrate: false,
    })

    expect(await fixture.persistence.restore()).toBe(false)
    expect(fixture.persistence.restorationState.value).toBe('failed')
    expect(await fixture.persistence.flushPending()).toBe(false)
    expect(fixture.saves).toEqual([])
    expect(buddyUserContentToText(fixture.runtimeDraft('global')!.content)).toBe('saved before restart')
    failing = false

    expect(await fixture.persistence.restore()).toBe(true)
    expect(fixture.persistence.restorationState.value).toBe('ready')
    expect(fixture.drafts.draft.value).toBe('saved before restart')
    expect(fixture.saves).toEqual([])
  })

  it('shares concurrent restore attempts and retains edits and resources owned by the opened Draft', async () => {
    const opening = deferred<void>()
    const fixture = await createFixture({ beforeOpen: () => opening.promise, hydrate: false })
    const draftId = fixture.drafts.draftId.value
    const first = fixture.persistence.restore()
    const second = fixture.persistence.restore()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(fixture.opens).toHaveLength(1))
    const content = {
      ...createBuddyUserContent('entered during recovery'),
      panelResourceIds: ['local-resource'],
    }
    fixture.drafts.setUserContent(content)
    opening.resolve()

    expect(await first).toBe(true)
    expect(fixture.drafts.draftId.value).toBe(draftId)
    expect(fixture.runtimeDraft('global')).toMatchObject({ draftId, content })
    expect(fixture.persistence.restorationConflict.value).toBeNull()
  })

  it('preserves navigation and both drafts when delayed restoration finds a different saved Draft', async () => {
    const reading = deferred<void>()
    const fixture = await createFixture({ beforeReady: () => reading.promise, confirmedContent: 'unseen remote input', hydrate: false })
    const sourceId = fixture.drafts.draftId.value
    const restoring = fixture.persistence.restore()
    updateText(fixture.drafts, 'local source input')
    fixture.session.activateDraft('space-1')
    updateText(fixture.drafts, 'local destination input')
    const destinationId = fixture.drafts.draftId.value
    reading.resolve()

    expect(await restoring).toBe(false)
    expect(fixture.session.spaceId.value).toBe('space-1')
    expect(fixture.drafts.draftId.value).toBe(destinationId)
    expect(fixture.drafts.draft.value).toBe('local destination input')
    expect(fixture.persistence.restorationConflict.value).toMatchObject({
      targetKey: 'global',
      local: { draftId: sourceId, content: createBuddyUserContent('local source input') },
      remote: { draftId: 'runtime-confirmed-draft', content: createBuddyUserContent('unseen remote input') },
    })
    expect(fixture.saves).toEqual([])
  })

  it('keeps foreign-owned inline and panel resources until the user explicitly restores the saved Draft', async () => {
    const opening = deferred<void>()
    const fixture = await createFixture({ beforeOpen: () => opening.promise, confirmedContent: 'remote input', hydrate: false })
    const localId = fixture.drafts.draftId.value
    const restoring = fixture.persistence.restore()
    await vi.waitFor(() => expect(fixture.opens).toHaveLength(1))
    const content = {
      body: [{ content: [{ type: 'resource_ref' as const, resourceId: 'local-resource' }], type: 'paragraph' as const }],
      panelResourceIds: ['local-resource'],
      version: 1 as const,
    }
    fixture.drafts.setUserContent(content)
    opening.resolve()
    expect(await restoring).toBe(false)
    expect(fixture.persistence.restorationState.value).toBe('conflict')
    expect(fixture.drafts.snapshot('global')).toMatchObject({ draftId: localId, content, revision: null })
    expect(await fixture.persistence.flushPending()).toBe(false)
    expect(fixture.saves).toEqual([])
    updateText(fixture.drafts, 'latest local input')
    expect(fixture.persistence.restorationConflict.value?.local.content).toEqual(createBuddyUserContent('latest local input'))
    const editorKey = fixture.drafts.editorKey.value

    expect(await fixture.persistence.resolveRemote('global')).toBe(true)
    expect(fixture.drafts.draftId.value).toBe('runtime-confirmed-draft')
    expect(fixture.drafts.draft.value).toBe('remote input')
    expect(fixture.drafts.editorKey.value).not.toBe(editorKey)
    expect(fixture.persistence.restorationConflict.value).toBeNull()
    expect(fixture.saves).toEqual([])
    expect(await fixture.persistence.flushPending()).toBe(true)
  })

  it.each([true, false])('preserves edits in a new scope when its delayed open finds another Draft (restoring=%s)', async (restoring) => {
    const reading = deferred<void>()
    const opening = deferred<void>()
    const fixture = await createFixture({
      beforeReady: restoring ? () => reading.promise : undefined,
      beforeOpen: input => input.scope.kind === 'space' && input.scope.spaceId === 'space-1' ? opening.promise : Promise.resolve(),
      confirmedContent: 'unseen saved destination',
      confirmedScope: { kind: 'space', spaceId: 'space-1' },
      hydrate: !restoring,
    })
    const recovery = restoring ? fixture.persistence.restore() : null
    fixture.session.activateDraft('space-1')
    const localId = fixture.drafts.draftId.value
    const pending = recovery ?? fixture.persistence.persist()
    reading.resolve()
    await vi.waitFor(() => expect(fixture.opens.some(input => input.scope.kind === 'space')).toBe(true))
    const content = {
      body: [{ content: [{ type: 'resource_ref' as const, resourceId: 'resource-from-local-draft' }], type: 'paragraph' as const }],
      panelResourceIds: ['resource-from-local-draft'],
      version: 1 as const,
    }
    fixture.drafts.setUserContent(content)
    fixture.session.activateDraft('space-2')
    opening.resolve()

    expect(await pending).toBe(false)
    expect(fixture.persistence.restorationState.value).toBe('conflict')
    expect(fixture.session.spaceId.value).toBe('space-2')
    expect(fixture.drafts.snapshot('space:space-1')).toMatchObject({ draftId: localId, content, revision: null })
    expect(fixture.persistence.restorationConflict.value).toMatchObject({
      targetKey: 'space:space-1',
      local: { draftId: localId, content },
      remote: { draftId: 'runtime-confirmed-draft', content: createBuddyUserContent('unseen saved destination') },
    })
    expect(await fixture.persistence.flushPending()).toBe(false)
    expect(fixture.saves).toEqual([])

    expect(await fixture.persistence.resolveRemote('space:space-1')).toBe(true)
    expect(fixture.session.spaceId.value).toBe('space-2')
    expect(fixture.drafts.snapshot('space:space-1')).toMatchObject({
      draftId: 'runtime-confirmed-draft',
      content: createBuddyUserContent('unseen saved destination'),
    })
  })

  it('retains edits made while the user-requested remote replacement is being read', async () => {
    const opening = deferred<void>()
    const replacing = deferred<void>()
    const fixture = await createFixture({ beforeGet: () => replacing.promise, beforeOpen: () => opening.promise, confirmedContent: 'remote input', hydrate: false })
    const restoring = fixture.persistence.restore()
    updateText(fixture.drafts, 'local conflict')
    opening.resolve()
    expect(await restoring).toBe(false)
    const localId = fixture.drafts.draftId.value
    const resolution = fixture.persistence.resolveRemote('global')
    updateText(fixture.drafts, 'edited while replacing')
    replacing.resolve()

    expect(await resolution).toBe(false)
    expect(fixture.drafts.draftId.value).toBe(localId)
    expect(fixture.drafts.draft.value).toBe('edited while replacing')
    expect(fixture.persistence.restorationState.value).toBe('conflict')
    expect(fixture.saves).toEqual([])
  })

  it.each(['ready', 'open'] as const)('does not apply a delayed %s or write during disposal before recovery', async (operation) => {
    const pending = deferred<void>()
    const fixture = await createFixture({
      beforeOpen: operation === 'open' ? () => pending.promise : undefined,
      beforeReady: operation === 'ready' ? () => pending.promise : undefined,
      confirmedContent: 'remote input',
      hydrate: false,
    })
    const restoring = fixture.persistence.restore()
    if (operation === 'open')
      await vi.waitFor(() => expect(fixture.opens).toHaveLength(1))
    updateText(fixture.drafts, 'local input')
    const localId = fixture.drafts.draftId.value
    fixture.persistence.dispose()
    pending.resolve()

    expect(await restoring).toBe(false)
    expect(await fixture.persistence.flushPending()).toBe(false)
    expect(fixture.drafts.draftId.value).toBe(localId)
    expect(fixture.drafts.draft.value).toBe('local input')
    expect(fixture.saves).toEqual([])
  })

  it('inherits permissions when opening a conversation Draft without changing the global Draft', async () => {
    const fixture = await createFixture()
    const conversation = createConversation('full_access')
    fixture.conversations.set(conversation.id, conversation)
    fixture.session.activateConversation(conversation)
    updateText(fixture.drafts, 'pending conversation text')

    expect(await fixture.persistence.persist()).toBe(true)
    const key = 'conversation:conversation-1:branch-1'
    expect(fixture.runtimeDraft(key)?.executionConfig).toEqual({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    expect(buddyUserContentToText(fixture.runtimeDraft(key)!.content)).toBe('pending conversation text')
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot(key))).toBe(true)
    expect(fixture.runtimeDraft('global')?.executionConfig.executionProfile).toBe('workspace_write')
  })

  it('updates the originating conversation Draft after navigation to another task', async () => {
    const fixture = await createFixture()
    const conversation = createConversation('workspace_write')
    fixture.conversations.set(conversation.id, conversation)
    fixture.session.activateConversation(conversation)
    updateText(fixture.drafts, 'source input')
    await fixture.persistence.persist()
    fixture.session.activateDraft(null)
    updateText(fixture.drafts, 'destination input')
    fixture.conversations.set(conversation.id, { ...conversation, approvalPolicy: 'manual' })

    expect(await fixture.persistence.persist()).toBe(true)
    const key = 'conversation:conversation-1:branch-1'
    expect(fixture.runtimeDraft(key)?.executionConfig.approvalPolicy).toBe('manual')
    expect(buddyUserContentToText(fixture.runtimeDraft(key)!.content)).toBe('source input')
    expect(fixture.drafts.draft.value).toBe('destination input')
    expect(fixture.drafts.approvalPolicy.value).toBe('policy')
  })

  it('reconciles a reopened Draft with current conversation permissions and preserves content', async () => {
    const fixture = await createFixture()
    const conversation = createConversation('workspace_write')
    fixture.conversations.set(conversation.id, conversation)
    fixture.session.activateConversation(conversation)
    updateText(fixture.drafts, 'saved before closing')
    await fixture.persistence.persist()
    fixture.drafts.hydrate([])
    fixture.conversations.set(conversation.id, createConversation('read_only'))

    expect(await fixture.persistence.persist()).toBe(true)
    expect(fixture.drafts.executionProfile.value).toBe('read_only')
    expect(fixture.drafts.draft.value).toBe('saved before closing')
    expect(fixture.runtimeDraft('conversation:conversation-1:branch-1')?.executionConfig.executionProfile).toBe('read_only')
  })

  it('coalesces a typing burst into the latest whole Runtime Draft', async () => {
    vi.useFakeTimers()
    const fixture = await createFixture()

    updateText(fixture.drafts, 'a')
    await vi.advanceTimersByTimeAsync(100)
    updateText(fixture.drafts, 'ab')
    await vi.advanceTimersByTimeAsync(100)
    updateText(fixture.drafts, 'abc')
    expect(fixture.saves).toEqual([])
    await vi.advanceTimersByTimeAsync(300)

    expect(fixture.saves.map(save => buddyUserContentToText(save.content))).toEqual(['abc'])
    expect(fixture.runtimeDraft('global')?.revision).toBe(1)
  })

  it('keeps one in-flight save and replaces pending edits across scopes', async () => {
    const saving = deferred<void>()
    const fixture = await createFixture({ beforeSave: () => saving.promise })
    updateText(fixture.drafts, 'first')
    const first = fixture.persistence.persist()
    await vi.waitFor(() => expect(fixture.saves).toHaveLength(1))

    updateText(fixture.drafts, 'superseded')
    const second = fixture.persistence.persist()
    updateText(fixture.drafts, 'latest source')
    fixture.session.activateDraft('space-1')
    updateText(fixture.drafts, 'destination')
    const third = fixture.persistence.persist()
    expect(fixture.saves).toHaveLength(1)
    saving.resolve()

    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(fixture.saves.map(save => buddyUserContentToText(save.content))).toEqual([
      'first',
      'latest source',
    ])
    expect(buddyUserContentToText(fixture.runtimeDraft('global')!.content)).toBe('latest source')
    expect(buddyUserContentToText(fixture.runtimeDraft('space:space-1')!.content)).toBe('destination')
  })

  it('captures editor changes made while resource acceptance is pending', async () => {
    const accepting = deferred<void>()
    const fixture = await createFixture({ beforePersist: () => accepting.promise })
    updateText(fixture.drafts, 'temporary input')
    const saving = fixture.persistence.persist()
    updateText(fixture.drafts, 'edited while accepting')
    expect(fixture.saves).toEqual([])
    accepting.resolve()

    expect(await saving).toBe(true)
    expect(fixture.saves.map(save => buddyUserContentToText(save.content))).toEqual([
      'edited while accepting',
    ])
  })

  it('confirms a committed revision when only the save response was lost', async () => {
    const fixture = await createFixture({ afterSave: () => {
      throw new Error('response lost')
    } })
    updateText(fixture.drafts, 'confirmed despite lost response')
    fixture.drafts.setModelSelection({ providerId: 'provider-1', modelId: 'model-1', reasoning: null, serviceTier: null })

    expect(await fixture.persistence.persist()).toBe(true)
    expect(fixture.errors).toEqual([])
    expect(fixture.saves).toHaveLength(1)
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(true)
  })

  it('keeps unsaved editor state after failure and retries the latest value', async () => {
    let fail = true
    const fixture = await createFixture({ beforeSave: async () => {
      if (fail)
        throw new Error('storage unavailable')
    } })
    updateText(fixture.drafts, 'unsaved')

    expect(await fixture.persistence.persist()).toBe(false)
    expect(fixture.drafts.draft.value).toBe('unsaved')
    expect(fixture.errors).toHaveLength(1)
    fail = false
    updateText(fixture.drafts, 'latest retry')

    expect(await fixture.persistence.flushPending()).toBe(true)
    expect(buddyUserContentToText(fixture.runtimeDraft('global')!.content)).toBe('latest retry')
  })

  it('preserves the dirty draft and revision when saving and reading both fail', async () => {
    let failing = true
    const unavailable = async () => {
      if (failing)
        throw new Error('Runtime unavailable')
    }
    const fixture = await createFixture({ confirmedContent: 'previously saved', beforeSave: unavailable, beforeGet: unavailable })
    const content = { ...createBuddyUserContent('/review unsaved notes'), panelResourceIds: ['local-resource'] }
    fixture.drafts.setUserContent(content)
    const snapshot = fixture.drafts.snapshot('global')

    expect(await fixture.persistence.persist()).toBe(false)
    expect(fixture.drafts.snapshot('global')).toEqual(snapshot)
    expect(fixture.drafts.isPersisted(snapshot)).toBe(false)
    expect(fixture.runtimeDraft('global')?.content).toEqual(createBuddyUserContent('previously saved'))
    expect(fixture.errors).toHaveLength(1)
    failing = false
    expect(await fixture.persistence.persist()).toBe(true)
    expect(fixture.runtimeDraft('global')?.content).toEqual(content)
    fixture.persistence.dispose()
  })

  it('hydrates the latest Runtime-confirmed Draft after a renderer restart', async () => {
    const fixture = await createFixture({ confirmedContent: 'confirmed before restart' })

    expect(fixture.drafts.draft.value).toBe('confirmed before restart')
    expect(fixture.drafts.draftId.value).toBe('runtime-confirmed-draft')
    expect(fixture.drafts.isPersisted(fixture.drafts.snapshot('global'))).toBe(true)
    expect(fixture.saves).toEqual([])
  })

  it('does not write navigation or Draft state before hydration succeeds', async () => {
    const fixture = await createFixture({ hydrate: false })
    updateText(fixture.drafts, 'not loaded')

    expect(await fixture.persistence.persist()).toBe(false)
    expect(fixture.saves).toEqual([])
  })
})

async function createFixture(options: {
  afterSave?: () => void
  beforeGet?: () => Promise<void>
  beforeOpen?: (input: LocalComposerDraftOpen) => Promise<void>
  beforeReady?: () => Promise<void>
  beforePersist?: () => Promise<void>
  beforeSave?: () => Promise<void>
  hydrate?: boolean
  confirmedContent?: string
  confirmedScope?: BuddyComposerDraftScope
} = {}) {
  const draftsByScope = new Map<string, LocalComposerDraft>()
  const conversations = new Map<string, LocalConversation>()
  const draftsById = new Map<string, LocalComposerDraft>()
  const saves: LocalComposerDraftSave[] = []
  const opens: LocalComposerDraftOpen[] = []
  const errors: unknown[] = []
  let scheduleSave = () => {}
  const session = useChatSession()
  const drafts = useChatDrafts({
    onChange: () => scheduleSave(),
    targetKey: computed(() => session.activeConversationId.value && session.activeBranchId.value
      ? `conversation:${session.activeConversationId.value}:${session.activeBranchId.value}`
      : session.spaceId.value ? `space:${session.spaceId.value}` : 'global'),
  })
  const composerDrafts: Pick<LocalChatApi['composerDrafts'], 'list' | 'get' | 'open' | 'save'> = {
    async list() { return [...draftsById.values()] },
    async get(draftId) {
      await options.beforeGet?.()
      const draft = draftsById.get(draftId)
      if (!draft)
        throw new Error('Draft not found')
      return structuredClone(draft)
    },
    async open(input) {
      opens.push(structuredClone(input))
      await options.beforeOpen?.(input)
      const key = scopeKey(input.scope)
      const existing = draftsByScope.get(key)
      if (existing)
        return structuredClone(existing)
      const draft = openedDraft(input)
      draftsByScope.set(key, draft)
      draftsById.set(draft.draftId, draft)
      return structuredClone(draft)
    },
    async save(input) {
      saves.push(structuredClone(input))
      await options.beforeSave?.()
      const current = draftsById.get(input.draftId)
      if (!current || current.revision !== input.expectedRevision)
        throw new Error('Draft conflict')
      const draft: LocalComposerDraft = {
        ...current,
        content: structuredClone(input.content),
        executionConfig: structuredClone(input.executionConfig),
        modelSelection: buddyComposerDraftModelSelectionSchema.nullable().parse(input.modelSelection),
        revision: current.revision + 1,
        updatedAt: '2026-09-06T00:00:01.000Z',
      }
      draftsByScope.set(scopeKey(draft.scope), draft)
      draftsById.set(draft.draftId, draft)
      options.afterSave?.()
      return structuredClone(draft)
    },
  }
  if (options.confirmedContent) {
    const confirmed = openedDraft({
      draftId: 'runtime-confirmed-draft',
      initialContent: chatComposerDocumentToUserContent(
        createChatComposerContentFromText(options.confirmedContent),
      ),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      scope: options.confirmedScope ?? { kind: 'global' },
    })
    draftsByScope.set(scopeKey(confirmed.scope), confirmed)
    draftsById.set(confirmed.draftId, confirmed)
  }
  const draftPersistence = useTaskWorkspacePersistence({
    api: { composerDrafts },
    beforePersist: options.beforePersist,
    getConversation: id => conversations.get(id) ?? null,
    drafts,
    onError: error => errors.push(error),
    session,
  })
  const persistence = { ...draftPersistence, restore: () => draftPersistence.restore(options.beforeReady?.()) }
  scheduleSave = persistence.persistIfHydrated
  if (options.hydrate !== false)
    await persistence.restore()
  return {
    conversations,
    drafts,
    errors,
    opens,
    persistence,
    runtimeDraft: (key: string) => draftsByScope.get(key),
    saves,
    session,
  }
}

function createConversation(executionProfile: LocalConversation['executionProfile']): LocalConversation {
  return {
    id: 'conversation-1',
    activeBranchId: 'branch-1',
    approvalPolicy: 'policy',
    executionProfile,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    deletedAt: null,
    modelSelection: null,
    spaceId: null,
    title: 'Fixture',
  }
}

function openedDraft(input: LocalComposerDraftOpen): LocalComposerDraft {
  return {
    content: structuredClone(input.initialContent),
    draftId: input.draftId,
    executionConfig: structuredClone(input.initialExecutionConfig),
    modelSelection: structuredClone(input.initialModelSelection),
    revision: 0,
    scope: structuredClone(input.scope),
    updatedAt: '2026-09-06T00:00:00.000Z',
  }
}

function scopeKey(scope: BuddyComposerDraftScope): string {
  switch (scope.kind) {
    case 'task': return `draft:${scope.draftId}`
    case 'global': return 'global'
    case 'space': return `space:${scope.spaceId}`
    case 'conversation_branch': return `conversation:${scope.conversationId}:${scope.branchId}`
    case 'message_followup': return `message-followup:${scope.conversationId}:${scope.branchId}:${scope.assistantMessageId}`
    case 'message_edit': return `message-edit:${scope.conversationId}:${scope.branchId}:${scope.userMessageId}`
  }
}

function updateText(drafts: ReturnType<typeof useChatDrafts>, text: string) {
  drafts.updateComposerContent(text, createChatComposerContentFromText(text))
}
