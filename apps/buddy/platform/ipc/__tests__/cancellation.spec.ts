import type { RuntimeMessageTransport } from '../../../shared/runtime/rpcPeer'
import { expect, it, vi } from 'vitest'
import { RuntimeRpcPeer } from '../runtimeRpcPeer'

function peers() {
  let left: (message: unknown) => void = () => {}
  let right: (message: unknown) => void = () => {}
  const first: RuntimeMessageTransport = { postMessage: message => right(message), subscribe: (listener) => {
    left = listener
    return () => left = () => {}
  } }
  const second: RuntimeMessageTransport = { postMessage: message => left(message), subscribe: (listener) => {
    right = listener
    return () => right = () => {}
  } }
  return [new RuntimeRpcPeer({ transport: first }), new RuntimeRpcPeer({ transport: second })] as const
}
it.each([5000, null])('cancels remote work and discards late replies with timeout %s without cancelling later requests', async (timeout) => {
  const [client, server] = peers()
  let signal: AbortSignal | undefined
  let complete!: (value: string) => void
  server.onRequest('slow', (_, received) => {
    signal = received
    return new Promise(resolve => complete = resolve)
  })
  server.onRequest('next', () => 'next result')
  const controller = new AbortController()
  const promise = client.request('slow', {}, timeout, controller.signal)
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(signal?.aborted).toBe(true)
  complete('stale result')
  expect(await client.request('next', {})).toBe('next result')
  client.close(new Error('closed'))
  server.close(new Error('closed'))
})
it.each([undefined, null])('aborts handlers when their connection closes with timeout %s', async (timeout) => {
  const [client, server] = peers()
  let signal: AbortSignal | undefined
  server.onRequest('slow', (_, received) => {
    signal = received
    return new Promise(resolve => received?.addEventListener('abort', () => resolve(null)))
  })
  const promise = client.request('slow', {}, timeout)
  const rejected = expect(promise).rejects.toThrow('closed')
  server.close(new Error('closed'))
  client.close(new Error('closed'))
  await rejected
  expect(signal?.aborted).toBe(true)
})

it('waits for lifecycle-owned requests without a transport deadline while preserving default deadlines', async () => {
  vi.useFakeTimers()
  const [client, server] = peers()
  let complete!: (value: string) => void
  server.onRequest('queued', () => new Promise(resolve => complete = resolve))
  server.onRequest('timed', () => new Promise(() => {}))
  try {
    const queued = client.request('queued', {}, null)
    const timed = expect(client.request('timed', {})).rejects.toMatchObject({ code: 'RUNTIME_REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(150000)
    await timed
    complete('completed')
    expect(await queued).toBe('completed')
  }
  finally {
    client.close(new Error('closed'))
    server.close(new Error('closed'))
    vi.useRealTimers()
  }
})

it('keeps notification observers independent from request outcomes and preserves delivery order under reentry', async () => {
  const [client, server] = peers()
  const seen: string[] = []
  server.onNotification((method) => {
    if (method === 'outer')
      client.notify('inner', null)
    seen.push(`first:${method}`)
    throw new Error('fixture observer failure')
  })
  server.onNotification(method => seen.push(`second:${method}`))
  server.onRequest('committed', () => ({ committed: true }))
  client.notify('outer', null)
  expect(seen).toEqual(['first:outer', 'second:outer', 'first:inner', 'second:inner'])
  await expect(client.request('committed', null)).resolves.toEqual({ committed: true })
  client.close(new Error('closed'))
  server.close(new Error('closed'))
})

it('owns nested notification data before observers run without freezing the sender', async () => {
  const [client, server] = peers()
  const original = { nested: { value: 'committed' } }
  const received: unknown[] = []
  server.onNotification((_, params) => {
    Reflect.set((params as typeof original).nested, 'value', 'corrupted')
    throw new Error('fixture observer failure')
  })
  server.onNotification((_, params) => received.push(params))
  client.notify('fact', original)
  original.nested.value = 'sender changed'
  expect(received).toEqual([{ nested: { value: 'committed' } }])
  expect(Object.isFrozen(original.nested)).toBe(false)
  server.onRequest('available', () => true)
  await expect(client.request('available', null)).resolves.toBe(true)
  client.close(new Error('closed'))
  server.close(new Error('closed'))
})
