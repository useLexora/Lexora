import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'
import type { DraftRecoveryApi, DraftRecoveryOwner } from '@buddy-shared/conversation/draftRecovery'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RendererDraftStore } from '@buddy-electron/main/productProtocol/RendererDraftStore'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it } from 'vitest'
import { computed, shallowRef } from 'vue'
import { createDraftRecovery } from '../createDraftRecovery'
import { useChatDrafts } from '../useChatDrafts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const owner: DraftRecoveryOwner = { serviceId: 'service', profileId: 'profile', dataGeneration: 'generation', deviceId: 'desktop' }
async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'draft-recovery-'))
  roots.push(root)
  const store = new RendererDraftStore(root)
  const api = (identity = owner): DraftRecoveryApi => ({
    load: async () => ({ owner: identity, records: await store.load() }),
    write: record => store.write(record),
    remove: input => store.remove(input.owner, input.editorSessionId, input.sequence),
  })
  return { store, api }
}
function editor(api: DraftRecoveryApi) {
  const target = shallowRef('global')
  const drafts = useChatDrafts({ targetKey: computed(() => target.value), onChange: () => {} })
  const errors: unknown[] = []
  const journal = createDraftRecovery({ api, drafts, onError: error => errors.push(error) })
  return { drafts, journal, target, errors }
}
function remote(draftId: string, text: string, revision: number): LocalComposerDraft {
  return { draftId, content: createBuddyUserContent(text), executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, modelSelection: null, revision, scope: { kind: 'global' }, updatedAt: '2026-11-06T00:00:00.000Z' }
}

describe('local draft recovery', () => {
  it('recovers local edits without an exit callback, lazily preserves other scopes, and retains the edit sequence', async () => {
    const { store, api } = await storage()
    const first = editor(api())
    await first.journal.initialize()
    first.drafts.setUserContent(createBuddyUserContent('local input before server save'))
    const original = first.drafts.snapshot('global')
    first.target.value = 'space:space-1'
    first.drafts.setUserContent({ ...createBuddyUserContent('another scope'), panelResourceIds: ['resource-1'] })
    await first.journal.flush()
    expect(await store.load()).toHaveLength(2)
    const reopened = editor(api())
    await reopened.journal.initialize()
    expect(reopened.drafts.snapshot('global')).toEqual(original)
    expect(reopened.journal.copies.value).toHaveLength(1)
    reopened.target.value = 'space:space-1'
    reopened.journal.restoreScope('space:space-1')
    expect(reopened.drafts.draft.value).toBe('another scope')
    expect(reopened.drafts.resourceIdsForDraft(reopened.drafts.draftId.value)).toEqual(['resource-1'])
    expect(reopened.journal.copies.value).toEqual([])
  })

  it('retains newer local edits after a late save acknowledgement and a reload', async () => {
    const { api } = await storage()
    const first = editor(api())
    await first.journal.initialize()
    const initial = first.drafts.snapshot('global')
    first.drafts.confirmOpen(initial, remote(initial.draftId, '', 0))
    first.drafts.setUserContent(createBuddyUserContent('submitted'))
    const submitted = first.drafts.snapshot('global')
    await first.journal.flush()
    first.drafts.setUserContent(createBuddyUserContent('typed while saving'))
    first.drafts.confirmSave(submitted, remote(submitted.draftId, 'submitted', 1))
    await first.journal.flush()
    const reopened = editor(api())
    await reopened.journal.initialize()
    expect(reopened.drafts.draft.value).toBe('typed while saving')
    expect(reopened.drafts.snapshot('global')).toMatchObject({ revision: 1, editVersion: submitted.editVersion + 1 })
    expect(reopened.drafts.isPersisted(reopened.drafts.snapshot('global'))).toBe(false)
  })

  it.each([false, true])('durably applies a send acknowledgement without erasing edits made during send (edited=%s)', async (edited) => {
    const { store, api } = await storage()
    const first = editor(api())
    await first.journal.initialize()
    first.drafts.setUserContent(createBuddyUserContent('submitted'))
    const submitted = first.drafts.snapshot('global')
    first.drafts.confirmSave(submitted, remote(submitted.draftId, 'submitted', 1))
    await first.journal.flush()
    if (edited)
      first.drafts.setUserContent(createBuddyUserContent('next input'))
    first.drafts.acknowledgeSend({ draftId: submitted.draftId, sourceRevision: 1, committedRevision: 2 }, 'global')
    await first.journal.flush()
    const records = await store.load()
    expect(records).toHaveLength(1)
    expect(records[0]!.snapshot.editorSessionId).not.toBe(submitted.editorSessionId)
    const reopened = editor(api())
    await reopened.journal.initialize()
    expect(reopened.drafts.draft.value).toBe(edited ? 'next input' : '')
    expect(reopened.drafts.snapshot('global').revision).toBe(2)
  })

  it('never restores inputs from another generation into the current editor', async () => {
    const { store, api } = await storage()
    const previous = editor(api())
    await previous.journal.initialize()
    previous.drafts.setUserContent(createBuddyUserContent('previous generation input'))
    await previous.journal.flush()
    const current = editor(api({ ...owner, dataGeneration: 'new-generation' }))
    await current.journal.initialize()
    expect(current.drafts.draft.value).toBe('')
    expect(current.journal.recoveredTargets.size).toBe(0)
    expect(current.journal.copies.value).toHaveLength(1)
    current.drafts.setUserContent(createBuddyUserContent('new generation input'))
    await current.journal.flush()
    expect(await store.load()).toHaveLength(2)
  })
})
