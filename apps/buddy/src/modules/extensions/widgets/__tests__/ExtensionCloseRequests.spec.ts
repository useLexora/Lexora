import type { ExtensionViewHostMessage } from '@buddy-shared/extensions/extensionEvents'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionCloseRequests } from '../ExtensionCloseRequests'

const session = { id: 'view', extensionId: 'tests.office', generation: 'generation', token: 'token', url: 'about:blank' }
afterEach(() => vi.useRealTimers())
function fixture() {
  const sent: ExtensionViewHostMessage[] = []
  let current = true
  const requests = new ExtensionCloseRequests((_, message) => sent.push(message), candidate => current && candidate === session)
  return { sent, requests, invalidate: () => {
    current = false
  }, id: () => {
    const message = sent.find(message => 'closeRequest' in message)
    if (!message || !('closeRequest' in message))
      throw new Error('Expected close request')
    return message.closeRequest.id
  } }
}

it('coalesces concurrent closes and accepts only a boolean reply from the original session', async () => {
  const f = fixture()
  const result = f.requests.request(session)
  expect(f.requests.request(session)).toBe(result)
  let settled = false
  void result.then(() => {
    settled = true
  })
  f.requests.receive({ ...session, token: 'foreign' }, { id: f.id(), allowed: true })
  f.requests.receive(session, { id: f.id(), allowed: 'true' })
  await Promise.resolve()
  expect(settled).toBe(false)
  f.requests.receive(session, { id: f.id(), allowed: false })
  expect(await result).toBe(false)
  const again = f.requests.request(session)
  const next = f.sent.at(-1)!
  if (!('closeRequest' in next))
    throw new Error('Expected retry')
  f.requests.receive(session, { id: next.closeRequest.id, allowed: true })
  expect(await again).toBe(true)
})

it.each(['timeout', 'invalidate', 'dispose', 'abort'] as const)('preserves the editor when its close check ends through %s', async (operation) => {
  vi.useFakeTimers()
  const f = fixture()
  const abort = new AbortController()
  const result = f.requests.request(session, abort.signal)
  if (operation === 'abort')
    abort.abort()
  if (operation === 'timeout')
    await vi.advanceTimersByTimeAsync(30000)
  if (operation === 'invalidate') {
    f.invalidate()
    f.requests.reconcile()
  }
  if (operation === 'dispose')
    f.requests.dispose()
  f.requests.receive(session, { id: f.id(), allowed: true })
  expect(await result).toBe(false)
  expect(f.sent.at(-1)).toEqual({ closeCancel: f.id() })
})
