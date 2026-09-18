import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { BuddyServicePeer } from '../BuddyServicePeer'

class FakeUtilityProcess extends EventEmitter {
  readonly sent: unknown[] = []

  postMessage(message: unknown): void {
    this.sent.push(message)
  }
}

describe('utilityRuntimePeer', () => {
  it('rejects every pending request when the generation closes', async () => {
    const process = new FakeUtilityProcess()
    const peer = new BuddyServicePeer({ process })
    const first = peer.request('runtime.status', {})
    const second = peer.request('runtime.localState', {})

    peer.close(new Error('runtime generation exited'))

    await expect(first).rejects.toThrow('runtime generation exited')
    await expect(second).rejects.toThrow('runtime generation exited')
  })

  it('closes the generation after an invalid wire message', async () => {
    const process = new FakeUtilityProcess()
    const onFatalError = vi.fn()
    const peer = new BuddyServicePeer({ process, onFatalError })
    const response = peer.request('runtime.status', {})

    process.emit('message', {
      jsonrpc: '2.0',
      id: 'unexpected-id',
      result: true,
      unexpected: true,
    })

    await expect(response).rejects.toMatchObject({ code: 'RUNTIME_PROTOCOL_ERROR' })
    expect(onFatalError).toHaveBeenCalledOnce()
  })

  it('times out one request without closing the peer', async () => {
    vi.useFakeTimers()
    const process = new FakeUtilityProcess()
    const peer = new BuddyServicePeer({ process, defaultTimeoutMs: 20 })
    const timedOut = peer.request('runtime.status', {})
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      code: 'RUNTIME_REQUEST_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(20)
    await timedOutExpectation

    const next = peer.request('runtime.localState', {})
    const request = process.sent.at(-1) as { id: string }
    process.emit('message', {
      jsonrpc: '2.0',
      id: request.id,
      result: { status: 'ready' },
    })

    await expect(next).resolves.toEqual({ status: 'ready' })
    vi.useRealTimers()
  })
})
