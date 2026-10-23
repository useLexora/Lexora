import type { ExtensionViewHostMessage } from '@buddy-shared/extensions/extensionEvents'
import { expect, it } from 'vitest'
import { ExtensionReferenceRequests } from '../ExtensionReferenceRequests'

const session = { id: 'view', extensionId: 'tests.reader', generation: 'generation', token: 'token', url: 'about:blank' }
const input = { referenceId: 'quote', text: 'Frozen text', locator: null }
function fixture() {
  const sent: ExtensionViewHostMessage[] = []
  let current = true
  const requests = new ExtensionReferenceRequests((_, message) => sent.push(message), candidate => current && candidate === session)
  return { sent, requests, invalidate: () => {
    current = false
  }, id: () => {
    const message = sent.find(message => 'referenceRequest' in message)
    if (!message || !('referenceRequest' in message))
      throw new Error('Expected request')
    return message.referenceRequest.id
  } }
}

it('waits for a boolean confirmation from the addressed session and rejects unrelated replies', async () => {
  const f = fixture()
  let settled = false
  const result = f.requests.request(session, input, new AbortController().signal).then((value) => {
    settled = true
    return value
  })
  f.requests.receive({ ...session, token: 'other' }, { id: f.id(), located: true })
  f.requests.receive(session, { id: 'other-request', located: true })
  f.requests.receive(session, { id: f.id(), located: 'true' })
  await Promise.resolve()
  expect(settled).toBe(false)
  f.requests.receive(session, { id: f.id(), located: true })
  expect(await result).toBe(true)
})

it.each(['abort', 'invalidate', 'dispose'] as const)('settles false on %s and ignores a late response', async (operation) => {
  const f = fixture()
  const abort = new AbortController()
  const result = f.requests.request(session, input, abort.signal)
  if (operation === 'abort')
    abort.abort()
  if (operation === 'invalidate') {
    f.invalidate()
    f.requests.reconcile()
  }
  if (operation === 'dispose')
    f.requests.dispose()
  f.requests.receive(session, { id: f.id(), located: true })
  expect(await result).toBe(false)
  expect(f.sent.at(-1)).toEqual({ referenceCancel: f.id() })
})
