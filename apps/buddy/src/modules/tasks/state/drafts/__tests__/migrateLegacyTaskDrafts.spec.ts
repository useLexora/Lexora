import type { LocalComposerDraft, LocalComposerDraftOpen } from '@buddy-shared/conversation/composerApi'
import type { LocalWorkspaceSetting, LocalWorkspaceStateValue } from '@buddy-shared/conversation/workspaceApi'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { LOCAL_WORKSPACE_STATE_KEY } from '@buddy-shared/conversation/workspaceApi'
import { describe, expect, it, vi } from 'vitest'
import { migrateLegacyTaskDrafts } from '../migrateLegacyTaskDrafts'

function fixture() {
  const timestamp = '2026-09-18T00:00:00.000Z'
  const legacy = (targetKey: string, draftId: string) => ({ targetKey, draftId, content: `Saved ${draftId}`, composerContent: null, attachments: [], approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const, requestId: null, requestFingerprint: null })
  let setting: LocalWorkspaceSetting = { key: LOCAL_WORKSPACE_STATE_KEY, updatedAt: timestamp, value: { activeConversationId: null, spaceId: 'space', drafts: [legacy('global', 'first'), legacy('space:space', 'second')] } }
  const drafts = new Map<string, LocalComposerDraft>()
  const open = vi.fn(async (input: LocalComposerDraftOpen) => {
    if (!drafts.has(input.draftId))
      drafts.set(input.draftId, { draftId: input.draftId, scope: input.scope, content: input.initialContent, executionConfig: input.initialExecutionConfig, modelSelection: input.initialModelSelection, revision: 0, updatedAt: timestamp })
    return drafts.get(input.draftId)!
  })
  const api = { composerDrafts: { open }, workspaceState: { read: async () => setting, write: async (value: LocalWorkspaceStateValue) => setting = { ...setting, value } } }
  return { api, drafts, open, setting: () => setting }
}

describe('legacy workspace import', () => {
  it('preserves draft identities, contents, permissions and Space ownership', async () => {
    const f = fixture()
    await migrateLegacyTaskDrafts(f.api, [])
    expect(f.drafts.get('first')?.scope).toEqual({ kind: 'task', draftId: 'first', spaceId: null })
    expect(f.drafts.get('second')?.scope).toEqual({ kind: 'task', draftId: 'second', spaceId: 'space' })
    expect(buddyUserContentToText(f.drafts.get('second')!.content)).toBe('Saved second')
    expect(f.drafts.get('second')?.executionConfig).toEqual({ approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    expect(f.setting().value).toEqual({ activeConversationId: null, spaceId: 'space' })
  })
  it('resumes a partial import without overwriting newer content or revision', async () => {
    const f = fixture()
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(open).mockRejectedValueOnce(new Error('interrupted'))
    await expect(migrateLegacyTaskDrafts(f.api, [])).rejects.toThrow('interrupted')
    expect('drafts' in f.setting().value).toBe(true)
    const newer = { ...f.drafts.get('first')!, revision: 4, content: createBuddyUserContent('Edited after recovery') }
    f.drafts.set('first', newer)
    await migrateLegacyTaskDrafts(f.api, [])
    expect(f.drafts.get('first')).toEqual(newer)
    expect(f.drafts.size).toBe(2)
    expect('drafts' in f.setting().value).toBe(false)
  })
  it('retains the original record when the target belongs to a different draft', async () => {
    const f = fixture()
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(async input => ({ ...await open(input), draftId: 'different' }))
    await expect(migrateLegacyTaskDrafts(f.api, [])).rejects.toThrow('conflicts')
    expect('drafts' in f.setting().value).toBe(true)
  })
  it('keeps imported data when the final settings write fails and retries safely', async () => {
    const f = fixture()
    const write = f.api.workspaceState.write
    f.api.workspaceState.write = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockImplementation(write)
    await expect(migrateLegacyTaskDrafts(f.api, [])).rejects.toThrow('write failed')
    const before = [...f.drafts]
    await migrateLegacyTaskDrafts(f.api, [])
    expect([...f.drafts]).toEqual(before)
    expect('drafts' in f.setting().value).toBe(false)
  })
})
