import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { ExtensionCloseGuard } from '../ExtensionCloseGuard'

it('allows views without a guard and keeps failed saves open until explicit success', async () => {
  const replies: { id: string, allowed: boolean }[] = []
  const guard = new ExtensionCloseGuard((id, allowed) => replies.push({ id, allowed }))
  await guard.request('unregistered')
  for (const [id, handler] of [
    ['cancelled', () => false],
    ['failed', () => { throw new Error('save failed') }],
    ['saved', () => true],
  ] as const) {
    const registration = guard.register(handler)
    await guard.request(id)
    registration.dispose()
  }
  expect(replies).toEqual([{ id: 'unregistered', allowed: true }, { id: 'cancelled', allowed: false }, { id: 'failed', allowed: false }, { id: 'saved', allowed: true }])
})

it.each(['cancel', 'unregister', 'dispose'] as const)('awaits save completion and rejects late success after %s', async (operation) => {
  const replies: { id: string, allowed: boolean }[] = []
  const guard = new ExtensionCloseGuard((id, allowed) => replies.push({ id, allowed }))
  const save = deferred<boolean>()
  let signal: AbortSignal | undefined
  const registration = guard.register((lifetime) => {
    signal = lifetime
    return save.promise
  })
  const pending = guard.request('view')
  expect(replies).toEqual([])
  if (operation === 'cancel')
    guard.cancel('view')
  if (operation === 'unregister')
    registration.dispose()
  if (operation === 'dispose')
    guard.dispose()
  expect(signal?.aborted).toBe(true)
  save.resolve(true)
  await pending
  expect(replies).toEqual([{ id: 'view', allowed: false }])
})
