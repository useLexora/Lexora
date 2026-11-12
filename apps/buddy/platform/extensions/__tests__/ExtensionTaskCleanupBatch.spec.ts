import type { ExtensionTaskCleanupItem } from '../../../shared/extensions/extensionTaskCleanup'
import type { ExtensionTaskCleanupProgress } from '../ExtensionTaskCleanupBatch'
import { expect, it } from 'vitest'
import { runExtensionTaskCleanupBatch } from '../ExtensionTaskCleanupBatch'

function item(id: string): ExtensionTaskCleanupItem {
  return { conversationId: id, expectedRevision: 7, title: null, removedAt: '2026-01-01', estimatedBytes: null, canDelete: true, blockedReason: null }
}

it('reads all pages before one confirmation and freezes every target and revision', async () => {
  const records = Array.from({ length: 205 }, (_, index) => item(`task-${index}`))
  const reads: number[] = []
  const deletes: { conversationId: string, expectedRevision: number }[] = []
  const result = await runExtensionTaskCleanupBatch({
    assertCurrent: () => {},
    cleanup: {
      list: async ({ cursor }) => {
        const offset = Number(cursor ?? 0)
        reads.push(offset)
        return { items: records.slice(offset, offset + 100), nextCursor: offset + 100 < records.length ? String(offset + 100) : null }
      },
      delete: async (input) => {
        deletes.push(input)
        return { status: records.find(item => item.conversationId === input.conversationId)?.expectedRevision === input.expectedRevision ? 'deleted' : 'failed' }
      },
    },
    confirm: async (count) => {
      expect(count).toBe(205)
      expect(reads).toEqual([0, 100, 200])
      records[0]!.expectedRevision = 8
      records.push(item('late-task'))
      return true
    },
  })
  expect(result.results).toHaveLength(205)
  expect(result.results[0]).toEqual({ conversationId: 'task-0', expectedRevision: 7, status: 'failed' })
  expect(deletes.every(item => item.expectedRevision === 7)).toBe(true)
  expect(deletes.some(item => item.conversationId === 'late-task')).toBe(false)
})

it('does not submit jobs on cancellation or incomplete reads', async () => {
  const deleted: string[] = []
  const result = await runExtensionTaskCleanupBatch({ assertCurrent: () => {}, confirm: async () => false, cleanup: {
    list: async () => ({ items: [item('cancelled')], nextCursor: null }),
    delete: async (target) => {
      deleted.push(target.conversationId)
      return { status: 'deleted' }
    },
  } })
  expect(result).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: 1, processed: 0 } })
  await expect(runExtensionTaskCleanupBatch({ assertCurrent: () => {}, confirm: async () => {
    throw new Error('MUST_NOT_CONFIRM')
  }, cleanup: {
    list: async ({ cursor }) => {
      if (cursor)
        throw new Error('READ_FAILED')
      return { items: [item('partial')], nextCursor: 'next' }
    },
    delete: async (target) => {
      deleted.push(target.conversationId)
      return { status: 'deleted' }
    },
  } })).resolves.toMatchObject({ status: 'completed', results: [], summary: { phase: 'failed', total: null, processed: 0 } })
  expect(deleted).toEqual([])
})

it('reports failed and pending items separately without refreshing CAS or retrying', async () => {
  const calls: string[] = []
  const result = await runExtensionTaskCleanupBatch({ assertCurrent: () => {}, confirm: async () => true, cleanup: {
    list: async () => ({ items: [item('failed'), item('pending'), item('deleted'), { ...item('busy'), canDelete: false }], nextCursor: null }),
    delete: async ({ conversationId }) => {
      calls.push(conversationId)
      if (conversationId === 'failed')
        throw new Error('SOURCE_CHANGED')
      return { status: conversationId === 'pending' ? 'pending' : 'deleted' }
    },
  } })
  expect(calls).toEqual(['failed', 'pending', 'deleted'])
  expect(result.results.map(item => item.status)).toEqual(['failed', 'pending', 'deleted'])
})

it('publishes unknown totals while scanning and real processed counts including failures', async () => {
  const snapshots: ExtensionTaskCleanupProgress[] = []
  const result = await runExtensionTaskCleanupBatch({
    assertCurrent: () => {},
    progress: progress => snapshots.push(progress),
    confirm: async () => true,
    cleanup: {
      list: async ({ cursor }) => ({ items: cursor ? [item('deleted'), item('failed'), item('pending')] : [{ ...item('blocked'), canDelete: false }], nextCursor: cursor ? null : 'next' }),
      delete: async ({ conversationId }) => {
        if (conversationId === 'failed')
          throw new Error('EXTENSION_TASK_CLEANUP_SOURCE_CHANGED')
        return { status: conversationId === 'pending' ? 'pending' : 'deleted' }
      },
    },
  })
  expect(snapshots.filter(item => item.phase === 'scanning').every(item => item.total === null && item.processed === 0)).toBe(true)
  expect(snapshots.filter(item => item.phase === 'running').map(item => item.processed)).toEqual([0, 1, 2, 3])
  expect(snapshots.at(-1)).toEqual({ phase: 'failed', total: 3, processed: 3, deleted: 1, pending: 1, failed: 1, skipped: 1, errorCode: 'EXTENSION_TASK_CLEANUP_SOURCE_CHANGED' })
  expect(result.results).toHaveLength(3)
})

it('keeps an incomplete scan unknown and never confirms a partial target set', async () => {
  const snapshots: ExtensionTaskCleanupProgress[] = []
  await expect(runExtensionTaskCleanupBatch({
    assertCurrent: () => {},
    progress: progress => snapshots.push(progress),
    confirm: async () => { throw new Error('MUST_NOT_CONFIRM') },
    cleanup: {
      list: async ({ cursor }) => {
        if (cursor)
          throw new Error('EXTENSION_TASK_CLEANUP_SOURCE_CHANGED')
        return { items: [item('unprocessed'), { ...item('blocked'), canDelete: false }], nextCursor: 'next' }
      },
      delete: async () => { throw new Error('MUST_NOT_DELETE') },
    },
  })).resolves.toMatchObject({ summary: { phase: 'failed', errorCode: 'EXTENSION_TASK_CLEANUP_SOURCE_CHANGED' } })
  expect(snapshots.at(-1)).toEqual({ phase: 'failed', total: null, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 1, errorCode: 'EXTENSION_TASK_CLEANUP_SOURCE_CHANGED' })
  expect(snapshots.some(item => item.phase === 'confirming')).toBe(false)
})

it('rejects repeated cursors and duplicate targets instead of approving an unstable scan', async () => {
  for (const repeatedTarget of [true, false]) {
    let pages = 0
    await expect(runExtensionTaskCleanupBatch({
      assertCurrent: () => {},
      confirm: async () => { throw new Error('MUST_NOT_CONFIRM') },
      cleanup: {
        list: async () => ({ items: [item(repeatedTarget ? 'duplicate' : `task-${pages++}`)], nextCursor: 'repeated' }),
        delete: async () => { throw new Error('MUST_NOT_DELETE') },
      },
    })).resolves.toMatchObject({ summary: { phase: 'failed', errorCode: 'EXTENSION_TASK_CLEANUP_SOURCE_CHANGED' } })
  }
})
