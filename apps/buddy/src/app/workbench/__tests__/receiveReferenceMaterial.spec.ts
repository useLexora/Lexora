import type { TaskWorkspacePool } from '../TaskWorkspacePool'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { chatComposerDocumentToUserContent, userContentToChatComposerDocument } from '@/modules/prompt-input'
import { WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { receiveReferenceMaterial } from '../receiveReferenceMaterial'

function fixture() {
  let identity = 'draft-1'
  const document = shallowRef(userContentToChatComposerDocument(createBuddyUserContent('Keep this draft')))
  const composer = {
    draftId: shallowRef('draft-1'),
    composerContent: document,
    draft: shallowRef('Keep this draft'),
    selectSource: vi.fn(async () => 'resource-1'),
    importFileSnapshot: vi.fn(async (_file: File) => 'snapshot-1'),
    updateComposerContent: (_text: string, value: typeof document.value) => document.value = value,
  }
  const task = { workspace: { composer }, flushDrafts: vi.fn(async () => true) }
  const references = new WorkbenchSelectionReferences({ targets: () => [{
    id: 'task-view',
    identity,
    scope: 'draft:1',
    label: 'Draft',
    read: () => chatComposerDocumentToUserContent(document.value),
    write: content => composer.updateComposerContent(buddyUserContentToText(content), userContentToChatComposerDocument(content)),
  }] })
  const revoke = references.registerProvider('fixture', { captureSource: () => ({ identity: 'source', owner: null }) })
  const controller = { layout: { views: { 'task-view': { resource: { scheme: 'draft' } } } } } as unknown as WorkbenchController
  const pool = { peek: () => task } as unknown as TaskWorkspacePool
  const scope = references.captureScope('source-view')!
  return { composer, task, references, revoke, change: () => identity = 'draft-2', options: { references, controller, pool, scope, targetId: 'task-view', current: () => true } }
}

describe('reference material receiving', () => {
  it('receives a whole resource without replacing newer draft text or submitting a turn', async () => {
    const f = fixture()
    expect(await receiveReferenceMaterial({ ...f.options, material: { kind: 'source', source: { localPath: '/example/report.csv' } } })).toBe(true)
    expect(f.composer.composerContent.value.attrs?.panelResourceIds).toEqual(['resource-1'])
    expect(chatComposerDocumentToUserContent(f.composer.composerContent.value).body).toEqual(createBuddyUserContent('Keep this draft').body)
    expect(f.task.flushDrafts).toHaveBeenCalledOnce()
  })

  it('does not attach a late import after the target or source has been revoked', async () => {
    for (const invalidate of ['target', 'source']) {
      const f = fixture()
      const pending = Promise.withResolvers<string>()
      f.composer.selectSource.mockReturnValueOnce(pending.promise)
      const receiving = receiveReferenceMaterial({ ...f.options, material: { kind: 'source', source: { localPath: '/example/report.csv' } } })
      if (invalidate === 'target')
        f.change()
      else f.revoke()
      pending.resolve('resource-1')
      expect(await receiving).toBe(false)
      expect(f.composer.composerContent.value.attrs?.panelResourceIds).toEqual([])
      expect(f.task.flushDrafts).not.toHaveBeenCalled()
    }
  })

  it('imports bytes as a task-owned file and only acknowledges a persisted snapshot', async () => {
    const f = fixture()
    expect(await receiveReferenceMaterial({ ...f.options, material: { kind: 'file', name: 'report.csv', mimeType: 'text/csv', base64: btoa('a,b\n1,2') } })).toBe(true)
    const file = f.composer.importFileSnapshot.mock.calls[0]![0]
    expect(file.name).toBe('report.csv')
    expect(file.size).toBe(7)
    expect(f.composer.composerContent.value.attrs?.panelResourceIds).toEqual(['snapshot-1'])
    f.task.flushDrafts.mockResolvedValueOnce(false)
    expect(await receiveReferenceMaterial({ ...f.options, material: { kind: 'quote', quote: { id: 'reference-1', text: 'Frozen', source: { kind: 'view', title: 'Report', provider: 'fixture', target: null } } } })).toBe(false)
  })
})
