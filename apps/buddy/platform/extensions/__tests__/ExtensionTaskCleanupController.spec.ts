import type { ExtensionTaskCleanupPreview } from '../../../shared/extensions/extensionTaskCleanup'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { ExtensionTaskCleanupController } from '../ExtensionTaskCleanupController'

const item = { conversationId: 'legacy', expectedRevision: 1, title: null, removedAt: '2026-01-01', estimatedBytes: null, canDelete: true, blockedReason: null }

function fixture() {
  const confirming = deferred<{ preview: ExtensionTaskCleanupPreview, signal: AbortSignal }>()
  const answer = deferred<boolean>()
  const controller = new ExtensionTaskCleanupController()
  const abort = new AbortController()
  const deleted: string[] = []
  const options = { extensionId: 'test.cleanup', signal: abort.signal, assertCurrent: () => {}, confirm: async (preview: ExtensionTaskCleanupPreview, signal: AbortSignal) => {
    confirming.resolve({ preview, signal })
    return answer.promise
  }, cleanup: {
    list: async () => ({ items: [item], nextCursor: null }),
    delete: async ({ conversationId }: { conversationId: string }) => {
      deleted.push(conversationId)
      return { status: 'pending' as const }
    },
  } }
  return { controller, confirming, answer, abort, deleted, options }
}

it('allows only one batch and returns real pending receipts after plugin confirmation', async () => {
  const f = fixture()
  const run = f.controller.run(f.options)
  expect((await f.confirming.promise).preview).toEqual({ total: 1, skipped: 0 })
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  f.controller.cancelUnconfirmed('other.plugin')
  expect((await f.confirming.promise).signal.aborted).toBe(false)
  f.answer.resolve(true)
  expect(await run).toMatchObject({ summary: { phase: 'completed', total: 1, processed: 1, pending: 1, deleted: 0 } })
  expect(f.deleted).toEqual(['legacy'])
  expect(await f.controller.run({ ...f.options, confirm: async () => false })).toMatchObject({ status: 'cancelled', results: [] })
})

it.each(['hide', 'abort'] as const)('releases unanswered confirmation on %s and ignores late true', async (action) => {
  const f = fixture()
  const run = f.controller.run(f.options)
  const { signal } = await f.confirming.promise
  if (action === 'hide')
    f.controller.cancelUnconfirmed()
  else f.abort.abort()
  expect(signal.aborted).toBe(true)
  expect(await run).toMatchObject({ results: [], summary: { phase: action === 'hide' ? 'cancelled' : 'failed', processed: 0 } })
  const nextAnswer = deferred<boolean>()
  const nextStarted = deferred<void>()
  const next = f.controller.run({ ...f.options, signal: new AbortController().signal, confirm: async () => {
    nextStarted.resolve()
    return nextAnswer.promise
  } })
  await nextStarted.promise
  f.answer.resolve(true)
  await Promise.resolve()
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  nextAnswer.resolve(false)
  await next
  expect(f.deleted).toEqual([])
})

it('retains accepted receipts on invalidation without submitting remaining targets', async () => {
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
  await f.confirming.promise
  f.answer.resolve(true)
  await accepted.promise
  f.controller.cancelUnconfirmed()
  f.abort.abort()
  await expect(f.controller.run({ ...f.options, signal: new AbortController().signal })).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  receipt.resolve({ status: 'pending' })
  expect(await run).toMatchObject({ summary: { phase: 'failed', total: 2, processed: 1, pending: 1, deleted: 0, errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED' }, results: [{ conversationId: 'legacy', status: 'pending' }] })
  expect(f.deleted).toEqual(['legacy'])
})

it.each(['hide', 'abort'] as const)('releases a pending scan on %s and late reads cannot release the next operation lock', async (action) => {
  const f = fixture()
  const phases: string[] = []
  const entered = deferred<void>()
  const page = deferred<{ items: typeof item[], nextCursor: null }>()
  const run = f.controller.run({ ...f.options, progress: value => phases.push(value.phase), cleanup: { ...f.options.cleanup, list: () => {
    entered.resolve()
    return page.promise
  } } })
  await entered.promise
  if (action === 'hide')
    f.controller.cancelUnconfirmed()
  else f.abort.abort()
  const next = f.controller.run({ ...f.options, signal: new AbortController().signal })
  expect(await run).toMatchObject({ status: action === 'hide' ? 'cancelled' : 'completed', results: [], summary: { phase: action === 'hide' ? 'cancelled' : 'failed', total: null, processed: 0, errorCode: action === 'hide' ? null : 'EXTENSION_TASK_CLEANUP_EXPIRED' } })
  await f.confirming.promise
  const previousPhases = [...phases]
  page.resolve({ items: [item], nextCursor: null })
  await Promise.resolve()
  await Promise.resolve()
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  f.answer.resolve(false)
  await next
  expect(phases).toEqual(previousPhases)
  expect(f.deleted).toEqual([])
})

it.each([false, true])('releases an invalidated scan with pending progress, already hidden: %s', async (hidden) => {
  const f = fixture()
  const entered = deferred<void>()
  const delivery = deferred<void>()
  const phases: string[] = []
  const run = f.controller.run({ ...f.options, progress: async (value) => {
    phases.push(value.phase)
    entered.resolve()
    return delivery.promise
  }, cleanup: { ...f.options.cleanup, list: async () => {
    throw new Error('MUST_NOT_SCAN')
  } } })
  await entered.promise
  if (hidden) {
    f.controller.cancelUnconfirmed()
    await Promise.resolve()
    await Promise.resolve()
  }
  f.abort.abort()
  const next = f.controller.run({ ...f.options, signal: new AbortController().signal, confirm: async () => false })
  expect(await run).toMatchObject({ results: [], summary: { phase: hidden ? 'cancelled' : 'failed', processed: 0, errorCode: hidden ? null : 'EXTENSION_TASK_CLEANUP_EXPIRED' } })
  expect(await next).toMatchObject({ status: 'cancelled' })
  delivery.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(phases).toEqual(['scanning'])
  expect(f.deleted).toEqual([])
})

it('does not scan or confirm when the original invocation is already aborted', async () => {
  const f = fixture()
  f.abort.abort()
  const calls: string[] = []
  expect(await f.controller.run({ ...f.options, confirm: async () => {
    calls.push('confirm')
    return true
  }, cleanup: { ...f.options.cleanup, list: async () => {
    calls.push('list')
    return { items: [item], nextCursor: null }
  } } })).toMatchObject({ results: [], summary: { phase: 'failed', total: null, processed: 0, errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED' } })
  expect(calls).toEqual([])
  expect(f.deleted).toEqual([])
  expect(await f.controller.run({ ...f.options, signal: new AbortController().signal, confirm: async () => false })).toMatchObject({ status: 'cancelled' })
})

it.each(['before-first-delete', 'running'] as const)('continues only frozen confirmed targets when hidden %s', async (when) => {
  const f = fixture()
  const accepted = deferred<void>()
  const receipt = deferred<{ status: 'pending' }>()
  const records = [item, { ...item, conversationId: 'frozen' }]
  const run = f.controller.run({ ...f.options, progress: (progress) => {
    if (when === 'before-first-delete' && progress.phase === 'running')
      f.controller.cancelUnconfirmed()
  }, cleanup: {
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
  f.answer.resolve(true)
  await accepted.promise
  f.controller.cancelUnconfirmed()
  records.push({ ...item, conversationId: 'late-unapproved' })
  await expect(f.controller.run(f.options)).rejects.toThrow('EXTENSION_TASK_CLEANUP_BUSY')
  receipt.resolve({ status: 'pending' })
  expect(await run).toMatchObject({ summary: { phase: 'completed', total: 2, processed: 2, pending: 1, deleted: 1 } })
  expect(f.deleted).toEqual(['legacy', 'frozen'])
})

it('finishes hidden progress in order without late scan notifications', async () => {
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
  expect((await f.controller.run({ ...f.options, confirm: async () => false })).summary.phase).toBe('cancelled')
  release.resolve()
  expect(await run).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: null, processed: 0 } })
  expect(phases).toEqual(['scanning', 'cancelled'])
  expect(f.deleted).toEqual([])
})
