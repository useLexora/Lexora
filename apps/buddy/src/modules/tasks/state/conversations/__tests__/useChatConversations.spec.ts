import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useChatConversations } from '../useChatConversations'
import { useChatSession } from '../useChatSession'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function conversation(id: string): LocalConversation {
  return { id, activeBranchId: `branch-${id}`, createdAt: '2026-09-08T00:00:00.000Z', deletedAt: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, spaceId: null, title: id, updatedAt: '2026-09-08T00:00:00.000Z' }
}
function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const session = useChatSession()
  const lookup = deferred<LocalConversation>()
  const errors: unknown[] = []
  const persisted: (string | null)[] = []
  const owner = scope.run(() => useChatConversations({
    api: { conversations: { get: () => lookup.promise, listBranches: async () => [], listMessages: async () => ({ items: [], nextCursor: null }) } },
    session,
    taskIndexData: { conversations: shallowRef([{ ...conversation('indexed'), activity: 'idle' as const, automationOccurrence: null }]), applyConversation() {}, refreshIndex: async () => {} },
    clearError() {},
    onError: error => errors.push(error),
    persistWorkspaceState: async () => {
      persisted.push(session.activeConversationId.value)
      return true
    },
    runSync: { clearConversationState() {}, refreshActiveConversation: async () => {} },
    restoreConversationModelSelection() {},
    selectDefaultModel() {},
  }))!
  return { errors, lookup, owner, persisted, scope, session }
}

describe('task selection ownership', () => {
  it('does not activate a looked-up task after a later indexed selection', async () => {
    const f = fixture()
    const old = f.owner.openConversation('old')
    await f.owner.openConversation('indexed')
    f.lookup.resolve(conversation('old'))
    await old
    expect(f.session.activeConversationId.value).toBe('indexed')
    expect(f.persisted).toEqual(['indexed'])
  })

  it.each(['abort', 'draft', 'dispose'])('discards an unlisted task after %s', async (operation) => {
    const f = fixture()
    const controller = new AbortController()
    const opening = f.owner.openConversation('old', controller.signal)
    if (operation === 'abort')
      controller.abort()
    else if (operation === 'draft')
      await f.owner.activateGlobalDraft()
    else
      f.scope.stop()
    f.lookup.resolve(conversation('old'))
    await opening
    expect(f.session.activeConversationId.value).toBeNull()
    expect(f.persisted).not.toContain('old')
    expect(f.errors).toEqual([])
  })

  it('does not surface an old lookup error in the newly selected task', async () => {
    const f = fixture()
    const old = f.owner.openConversation('old')
    await f.owner.openConversation('indexed')
    f.lookup.reject(new Error('old task is unavailable'))
    await old
    expect(f.session.activeConversationId.value).toBe('indexed')
    expect(f.errors).toEqual([])
  })
})
