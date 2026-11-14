import type { DraftRecoveryRecord } from '../../../../shared/conversation/draftRecovery'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { RendererDraftStore } from '../RendererDraftStore'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'renderer-drafts-'))
  roots.push(root)
  return root
}
function record(): DraftRecoveryRecord {
  return {
    owner: { serviceId: 'service', profileId: 'profile', dataGeneration: 'generation', deviceId: 'desktop' },
    sequence: 1,
    snapshot: {
      targetKey: 'global',
      draftId: randomUUID(),
      editorSessionId: randomUUID(),
      editVersion: 1,
      revision: 2,
      confirmedSnapshot: null,
      content: createBuddyUserContent('unsent input'),
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      modelSelection: null,
    },
  }
}

describe('rendererDraftStore', () => {
  it('durably restores independent scopes and generations in a fresh store', async () => {
    const root = await directory()
    const store = new RendererDraftStore(root)
    const first = record()
    const second = record()
    second.snapshot.targetKey = 'space:space-1'
    second.owner.dataGeneration = 'previous-generation'
    await Promise.all([store.write(first), store.write(second)])
    expect(await new RendererDraftStore(root).load()).toEqual(expect.arrayContaining([first, second]))
  })

  it('rejects stale writes and preserves the deletion watermark across restarts', async () => {
    const root = await directory()
    const store = new RendererDraftStore(root)
    const first = record()
    const newer = { ...first, sequence: 2, snapshot: { ...first.snapshot, editVersion: 2, content: createBuddyUserContent('newer input') } }
    await store.write(newer)
    await expect(store.write(first)).rejects.toThrow('DRAFT_RECOVERY_STALE_WRITE')
    await store.write(newer)
    await store.remove(first.owner, first.snapshot.editorSessionId, 3)
    const restarted = new RendererDraftStore(root)
    await expect(restarted.write(newer)).rejects.toThrow('DRAFT_RECOVERY_STALE_WRITE')
    expect(await restarted.load()).toEqual([])
  })

  it('leaves malformed or future content intact instead of overwriting the recovery copy', async () => {
    const root = await directory()
    const store = new RendererDraftStore(root)
    const first = record()
    await store.write(first)
    const path = join(root, (await readdir(root))[0]!)
    const original = await readFile(path, 'utf8')
    const future = original.replace('"version":1', '"version":2')
    await writeFile(path, future)
    await expect(store.load()).rejects.toThrow()
    await expect(store.write({ ...first, sequence: 2 })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(future)
  })
})
