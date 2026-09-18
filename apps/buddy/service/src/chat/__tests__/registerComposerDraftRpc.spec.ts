import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ComposerDraftService } from '../ComposerDraftService'
import { registerComposerDraftRpc } from '../registerComposerDraftRpc'

describe('registerComposerDraftRpc', () => {
  it('validates and exposes open, get and CAS save as one strict runtime contract', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const handlers = new Map<string, RuntimeRequestHandler>()
    registerComposerDraftRpc({
      rpc: {
        onRequest(method, handler) {
          handlers.set(method, handler)
          return () => handlers.delete(method)
        },
      },
      service: new ComposerDraftService(createComposerDraftRepository(database), async () => {}),
    })
    const initial = {
      draftId: 'draft-1',
      initialContent: createBuddyUserContent('Hello'),
      initialExecutionConfig: {
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      },
      initialModelSelection: null,
      scope: { kind: 'global' },
    }

    const opened = await handlers.get('composerDrafts.open')!(initial)
    expect(opened).toMatchObject({ draftId: 'draft-1', revision: 0 })
    expect(await handlers.get('composerDrafts.get')!({ draftId: 'draft-1' })).toEqual(opened)
    expect(await handlers.get('composerDrafts.save')!({
      content: createBuddyUserContent('Updated'),
      draftId: 'draft-1',
      executionConfig: initial.initialExecutionConfig,
      expectedRevision: 0,
      modelSelection: null,
    })).toMatchObject({ revision: 1 })
    expect(() => handlers.get('composerDrafts.open')!({ ...initial, unknown: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    database.close()
  })
})
