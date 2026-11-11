import { deferred } from '@buddy-tests/deferred'
import { expect, it, vi } from 'vitest'
import { ExtensionTaskCleanupController } from '../ExtensionTaskCleanupController'

const item = { conversationId: 'legacy', expectedRevision: 1, title: null, removedAt: '2026-01-01', estimatedBytes: null, canDelete: true, blockedReason: null }

function fixture() {
  const confirming = deferred<void>()
  const controller = new ExtensionTaskCleanupController(() => {
    if (controller.confirmations().length)
      confirming.resolve()
  })
  const abort = new AbortController()
  const deleted: string[] = []
  const options = { extensionId: 'test.cleanup', menuId: 'test.cleanup.menu', signal: abort.signal, assertCurrent: () => {}, cleanup: {
    list: async () => ({ items: [item], nextCursor: null }),
    delete: async ({ conversationId }: { conversationId: string }) => {
      deleted.push(conversationId)
      return { status: 'pending' as const }
    },
  } }
  return { controller, confirming, abort, deleted, options }
}

it('requires the exact current operation and rejects duplicate batches across extensions', async () => {
  const f = fixture()
  const run = f.controller.run(f.options)
  await f.confirming.promise
  const operation = f.controller.snapshot('test.cleanup')!
  expect(operation).toMatchObject({ phase: 'confirming', total: 1, processed: 0, menuId: 'test.cleanup.menu' })
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  await expect(f.controller.run({ ...f.options, extensionId: 'other.cleanup' })).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  expect(() => f.controller.confirm('other.cleanup', operation.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  expect(() => f.controller.confirm('test.cleanup', 'old-operation', true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  f.controller.confirm('test.cleanup', operation.id, true)
  expect(() => f.controller.confirm('test.cleanup', operation.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  await run
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ phase: 'completed', total: 1, processed: 1, pending: 1, deleted: 0 })
  expect(f.deleted).toEqual(['legacy'])
  expect(f.controller.confirmations()).toEqual([])
  expect(() => f.controller.confirm('test.cleanup', operation.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  const next = f.controller.run(f.options)
  await vi.waitFor(() => expect(f.controller.confirmations()).toHaveLength(1))
  const latest = f.controller.snapshot('test.cleanup')!
  expect(latest.id).not.toBe(operation.id)
  expect(() => f.controller.confirm('test.cleanup', operation.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  latest.total = 2000
  f.controller.confirm('test.cleanup', latest.id, false)
  expect(await next).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: 1, processed: 0 } })
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ phase: 'cancelled', total: 1, processed: 0, pending: 0, deleted: 0 })
  expect(f.deleted).toEqual(['legacy'])
})

it('releases unanswered confirmation on invalidation without submitting anything', async () => {
  const f = fixture()
  const run = f.controller.run(f.options)
  const rejected = expect(run).resolves.toMatchObject({ summary: { phase: 'failed', errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED' } })
  await f.confirming.promise
  const operation = f.controller.snapshot('test.cleanup')!
  f.abort.abort()
  await rejected
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ phase: 'failed', total: 1, processed: 0, errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED' })
  expect(() => f.controller.confirm('test.cleanup', operation.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  expect(f.deleted).toEqual([])
})

it('retains accepted receipts after hiding and invalidation without submitting the remaining targets', async () => {
  const f = fixture()
  const accepted = deferred<void>()
  const receipt = deferred<{ status: 'pending' }>()
  const run = f.controller.run({ ...f.options, cleanup: {
    list: async () => ({ items: [item, { ...item, conversationId: 'remaining' }], nextCursor: null }),
    delete: async ({ conversationId }) => {
      f.deleted.push(conversationId)
      accepted.resolve()
      return receipt.promise
    },
  } })
  const rejected = expect(run).resolves.toMatchObject({ summary: { phase: 'failed', total: 2, processed: 1, pending: 1, deleted: 0, errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED' }, results: [{ conversationId: 'legacy', status: 'pending' }] })
  await f.confirming.promise
  f.controller.confirm('test.cleanup', f.controller.snapshot('test.cleanup')!.id, true)
  await accepted.promise
  f.controller.cancelUnconfirmed()
  f.abort.abort()
  await expect(f.controller.run({ ...f.options, signal: new AbortController().signal })).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  receipt.resolve({ status: 'pending' })
  await rejected
  expect(f.deleted).toEqual(['legacy'])
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ phase: 'failed', total: 2, processed: 1, pending: 1, deleted: 0, failed: 0, skipped: 0 })
})

it('cancels a hidden scan immediately and late reads cannot replace the next operation or release its lock', async () => {
  const f = fixture()
  const page = deferred<{ items: typeof item[], nextCursor: null }>()
  const run = f.controller.run({ ...f.options, cleanup: { ...f.options.cleanup, list: () => page.promise } })
  const previous = f.controller.snapshot('test.cleanup')!
  expect(previous.phase).toBe('scanning')
  f.controller.cancelUnconfirmed()
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ id: previous.id, phase: 'cancelled', total: null, processed: 0 })
  const next = f.controller.run(f.options)
  expect(await run).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled' } })
  await f.confirming.promise
  const current = f.controller.snapshot('test.cleanup')!
  expect(current.id).not.toBe(previous.id)
  page.resolve({ items: [item], nextCursor: null })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.controller.snapshot('test.cleanup')).toEqual(current)
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  expect(() => f.controller.confirm('test.cleanup', previous.id, true)).toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  f.controller.confirm('test.cleanup', current.id, false)
  await next
  expect(f.deleted).toEqual([])
})

it.each(['immediately-after-confirmation', 'running'] as const)('continues only the frozen confirmed batch when hidden %s', async (when) => {
  const f = fixture()
  const accepted = deferred<void>()
  const receipt = deferred<{ status: 'pending' }>()
  const records = [item, { ...item, conversationId: 'frozen' }]
  const run = f.controller.run({ ...f.options, cleanup: {
    list: async () => ({ items: records, nextCursor: null }),
    delete: async ({ conversationId }) => {
      f.deleted.push(conversationId)
      if (conversationId === 'legacy') {
        accepted.resolve()
        return receipt.promise
      }
      return { status: 'deleted' }
    },
  } })
  await f.confirming.promise
  f.controller.confirm('test.cleanup', f.controller.snapshot('test.cleanup')!.id, true)
  if (when === 'running')
    await accepted.promise
  f.controller.cancelUnconfirmed()
  records.push({ ...item, conversationId: 'late-unapproved' })
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  receipt.resolve({ status: 'pending' })
  await run
  expect(f.deleted).toEqual(['legacy', 'frozen'])
  expect(f.controller.snapshot('test.cleanup')).toMatchObject({ phase: 'completed', total: 2, processed: 2, pending: 1, deleted: 1 })
})

it('finishes hidden progress in order without publishing late scan state over the next operation', async () => {
  const f = fixture()
  const entered = deferred<void>()
  const release = deferred<void>()
  const phases: string[] = []
  const run = f.controller.run({ ...f.options, progress: async (progress) => {
    phases.push(progress.phase)
    if (progress.phase === 'scanning') {
      entered.resolve()
      await release.promise
    }
  } })
  await entered.promise
  f.controller.cancelUnconfirmed()
  const next = await f.controller.run({ ...f.options, confirm: async () => false })
  const current = f.controller.snapshot('test.cleanup')!
  expect(next.summary.phase).toBe('cancelled')
  release.resolve()
  expect(await run).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: null, processed: 0 } })
  expect(phases).toEqual(['scanning', 'cancelled'])
  expect(f.controller.snapshot('test.cleanup')).toEqual(current)
  expect(f.deleted).toEqual([])
})
