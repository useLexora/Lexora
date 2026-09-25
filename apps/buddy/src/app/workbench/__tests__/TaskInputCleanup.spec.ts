import type { LocalComposerDraft } from '@buddy-shared/conversation/composerApi'
import type { WorkbenchState } from '@buddy-shared/workbench/workbenchState'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { restoreWorkbenchLayout, WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { restoreTaskInputViews } from '../restoreTaskInputViews'
import { TaskInputCleanup } from '../TaskInputCleanup'

function controller() {
  const registry = new ContributionRegistry()
  registry.register('tasks', scope => scope.view({ locations: ['main'], id: 'task', renderer: 'task', label: 'Task', supports: () => true, multiple: false }))
  return new WorkbenchController(registry)
}

describe('task input cleanup', () => {
  it('keeps input through a failed layout save and replays durable cleanup after interruption', async () => {
    const workbench = controller()
    const records = new Set(['input'])
    const files = new Set(['input'])
    const snapshots: WorkbenchState[] = []
    let failSave = true
    let failRelease = true
    const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
      throw new Error('unused')
    } })
    const persistence = new WorkbenchPersistence({ read: async () => null, write: async (value) => {
      if (failSave)
        throw new Error('DISK_UNAVAILABLE')
      snapshots.push(structuredClone(value))
    } }, workbench, copies, () => {})
    const api = { list: async () => [], discard: async ({ draftId }: { draftId: string }) => {
      const snapshot = snapshots.at(-1)!
      expect(JSON.stringify(snapshot.layout)).not.toContain('"scheme":"draft"')
      expect(restoreWorkbenchLayout(snapshot.layout).auxiliary.pendingInputDiscards).toEqual([{ draftId: 'input', expectedRevision: 0 }])
      records.delete(draftId)
      if (failRelease)
        throw new Error('RELEASE_INTERRUPTED')
      files.delete(draftId)
      return true
    } }
    await persistence.restore()
    const view = (await workbench.open({ scheme: 'draft', id: 'input', data: {} }, 'Input'))!
    const cleanup = new TaskInputCleanup(workbench, persistence, api, () => false)
    cleanup.add({ draftId: 'input', expectedRevision: 0 })
    await workbench.close(view)
    await expect(cleanup.flush()).rejects.toThrow('DISK_UNAVAILABLE')
    expect([...records]).toEqual(['input'])
    failSave = false
    await expect(cleanup.flush()).rejects.toThrow('RELEASE_INTERRUPTED')
    expect([...records]).toEqual([])
    expect([...files]).toEqual(['input'])
    persistence.dispose()

    const restored = controller()
    const recovery = new WorkbenchPersistence({ read: async () => snapshots.at(-1)!, write: async (value) => {
      snapshots.push(structuredClone(value))
    } }, restored, copies, () => {})
    await recovery.restore()
    failRelease = false
    const resumed = new TaskInputCleanup(restored, recovery, api, () => false)
    await resumed.flush()
    expect([...files]).toEqual([])
    expect(resumed.pending()).toEqual([])
    expect(restoreWorkbenchLayout(snapshots.at(-1)!.layout).auxiliary.pendingInputDiscards).toEqual([])
    recovery.dispose()
  })

  it('removes abandoned new-task input while keeping open panes, context references and submitted tasks', async () => {
    const draft = (id: string): LocalComposerDraft => ({ draftId: id, scope: { kind: 'task', draftId: id, spaceId: null }, content: createBuddyUserContent(id), revision: 0, executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, modelSelection: null, updatedAt: new Date().toISOString() })
    const records = new Map(['open', 'context', 'orphan', 'submitted'].map(id => [id, draft(id)]))
    records.set('submitted', { ...records.get('submitted')!, scope: { kind: 'conversation_branch', conversationId: 'task', branchId: 'branch' } })
    const api = {
      list: async () => [...records.values()],
      discard: async ({ draftId, expectedRevision }: { draftId: string, expectedRevision: number }) => {
        const value = records.get(draftId)
        if (value && (value.scope.kind !== 'task' || value.revision !== expectedRevision))
          return false
        records.delete(draftId)
        return true
      },
    }
    const workbench = controller()
    const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async () => {
      throw new Error('unused')
    } })
    const persistence = new WorkbenchPersistence({ read: async () => null, write: async () => {} }, workbench, copies, () => {})
    await persistence.restore()
    await workbench.open({ scheme: 'draft', id: 'open', data: {} }, 'Open')
    const cleanup = new TaskInputCleanup(workbench, persistence, api, id => id === 'context')
    await cleanup.restore(false)
    expect(records.has('orphan')).toBe(true)
    await cleanup.restore(true)
    expect([...records.keys()]).toEqual(['open', 'context', 'submitted'])
    expect(cleanup.pending()).toEqual([])
    persistence.dispose()
  })

  it('restores submitted input as its task and removes discarded references from an older layout', async () => {
    const workbench = controller()
    const discarded = (await workbench.open({ scheme: 'draft', id: 'discarded', data: {} }, 'Gone'))!
    const sent = (await workbench.open({ scheme: 'draft', id: 'sent', data: {} }, 'Sent', { direction: 'right' }))!
    const record: LocalComposerDraft = { draftId: 'sent', scope: { kind: 'conversation_branch', conversationId: 'task', branchId: 'branch' }, content: createBuddyUserContent(), revision: 1, executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, modelSelection: null, updatedAt: '2026-09-18T00:00:00.000Z' }
    await restoreTaskInputViews(workbench.layout, { find: async id => id === 'sent' ? record : null })
    expect(workbench.layout.views[discarded]).toBeUndefined()
    expect(workbench.layout.views[sent]?.resource).toEqual({ scheme: 'task', id: 'task', data: {} })
    expect(workbench.layout.root).toMatchObject({ kind: 'pane', view: sent })
  })
})
