import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { ExtensionReferenceReveal } from '../ExtensionReferenceReveal'

const input = { referenceId: 'quote', text: 'Frozen text', locator: { version: 1, data: { block: 'summary' } } }
function fixture() {
  const replies: { id: string, located: boolean }[] = []
  const runtime = new ExtensionReferenceReveal((id, located) => replies.push({ id, located }))
  return { runtime, replies }
}

it('reports failure for a missing, rejecting or failing handler and succeeds only on explicit confirmation', async () => {
  const { runtime, replies } = fixture()
  await runtime.reveal('missing', input)
  for (const [id, handler] of [
    ['not-found', () => false],
    ['failed', () => { throw new Error('stale locator') }],
    ['located', () => true],
  ] as const) {
    const registration = runtime.onReveal(handler)
    await runtime.reveal(id, input)
    registration.dispose()
  }
  expect(replies).toEqual([{ id: 'missing', located: false }, { id: 'not-found', located: false }, { id: 'failed', located: false }, { id: 'located', located: true }])
})

it.each(['cancel', 'unregister', 'dispose', 'supersede'] as const)('cancels pending work and ignores a late success on %s', async (operation) => {
  const { runtime, replies } = fixture()
  const result = deferred<boolean>()
  let signal: AbortSignal | undefined
  const registration = runtime.onReveal((value, lifetime) => {
    signal = lifetime
    expect(value).toEqual(input)
    expect(Object.isFrozen(value.locator?.data)).toBe(true)
    return result.promise
  })
  const revealing = runtime.reveal('old', input)
  const original = signal!
  if (operation === 'cancel')
    runtime.cancel('old')
  if (operation === 'unregister')
    registration.dispose()
  if (operation === 'dispose')
    runtime.dispose()
  if (operation === 'supersede')
    void runtime.reveal('new', input)
  expect(original.aborted).toBe(true)
  result.resolve(true)
  await revealing
  expect(replies.filter(reply => reply.id === 'old')).toEqual([{ id: 'old', located: false }])
  runtime.dispose()
})
