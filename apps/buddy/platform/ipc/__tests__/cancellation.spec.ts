import type { RuntimeMessageTransport } from '../../../shared/runtime/rpcPeer'
import { expect, it } from 'vitest'
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
it('cancels remote work and discards late replies without cancelling later requests', async () => {
  const [client, server] = peers()
  let signal: AbortSignal | undefined
  let complete!: (value: string) => void
  server.onRequest('slow', (_, received) => {
    signal = received
    return new Promise(resolve => complete = resolve)
  })
  server.onRequest('next', () => 'next result')
  const controller = new AbortController()
  const promise = client.request('slow', {}, 5000, controller.signal)
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(signal?.aborted).toBe(true)
  complete('stale result')
  expect(await client.request('next', {})).toBe('next result')
  client.close(new Error('closed'))
  server.close(new Error('closed'))
})
it('aborts handlers when their connection closes', async () => {
  const [client, server] = peers()
  let signal: AbortSignal | undefined
  server.onRequest('slow', (_, received) => {
    signal = received
    return new Promise(resolve => received?.addEventListener('abort', () => resolve(null)))
  })
  const promise = client.request('slow', {})
  const rejected = expect(promise).rejects.toThrow('closed')
  server.close(new Error('closed'))
  client.close(new Error('closed'))
  await rejected
  expect(signal?.aborted).toBe(true)
})
