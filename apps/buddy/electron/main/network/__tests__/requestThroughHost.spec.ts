import type { Session } from 'electron'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostWebNetwork } from '../HostWebNetwork'
import { requestThroughHost } from '../requestThroughHost'

const net = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net }))

function transport(statusCode = 200, headers: Record<string, string> = {}) {
  let resumed = 0
  let aborted = false
  const incoming = Object.assign(new EventEmitter(), {
    statusCode,
    headers: { 'content-type': 'application/pdf', ...headers },
    pause() {},
    resume() {
      resumed++
      queueMicrotask(() => {
        incoming.emit('data', new TextEncoder().encode('file bytes'))
        incoming.emit('end')
      })
    },
  })
  const request = Object.assign(new EventEmitter(), {
    setHeader() {},
    write() {},
    end() { queueMicrotask(() => request.emit('response', incoming)) },
    abort() {
      aborted = true
    },
  })
  net.request.mockReturnValue(request)
  return {
    close: () => request.emit('close'),
    get resumed() { return resumed },
    get aborted() { return aborted },
  }
}

beforeEach(() => net.request.mockReset())

describe('host response body boundary', () => {
  it.each(['identity', 'gzip'])('retains %s representation metadata for identity downloads so the consumer can validate or reject it', async (encoding) => {
    const wire = transport(206, { 'content-range': 'bytes 3-12/13', 'content-length': '10', 'content-encoding': encoding, 'set-cookie': 'ignored=1' })
    const response = await requestThroughHost({} as Session, { url: 'https://example.com', method: 'GET', headers: { 'accept-encoding': 'identity', 'range': 'bytes=3-', 'if-range': '"v1"' } }, new AbortController().signal)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 3-12/13')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('content-encoding')).toBe(encoding)
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(wire.resumed).toBe(0)
    await response.body!.cancel()
    expect(wire.aborted).toBe(true)
  })

  it('continues hiding native decoded representation lengths from ordinary requests', async () => {
    transport(200, { 'content-length': '4', 'content-encoding': 'gzip' })
    const response = await requestThroughHost({} as Session, { url: 'https://example.com', method: 'GET', headers: {} }, new AbortController().signal)
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(await response.text()).toBe('file bytes')
  })

  it('reports native closure separately from headers and body completion', async () => {
    const wire = transport()
    let closed = false
    const response = await requestThroughHost({} as Session, { url: 'https://example.com', method: 'GET', headers: {} }, new AbortController().signal, undefined, (promise) => {
      void promise.then(() => {
        closed = true
      })
    })
    expect(closed).toBe(false)
    expect(await response.text()).toBe('file bytes')
    expect(closed).toBe(false)
    wire.close()
    await Promise.resolve()
    expect(closed).toBe(true)
  })

  it('does not report closure merely because abort was requested', async () => {
    const wire = transport()
    let closed = false
    const controller = new AbortController()
    const response = await requestThroughHost({} as Session, { url: 'https://example.com', method: 'GET', headers: {} }, controller.signal, undefined, (promise) => {
      void promise.then(() => {
        closed = true
      })
    })
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    expect(wire.aborted).toBe(true)
    expect(closed).toBe(false)
    wire.close()
    await Promise.resolve()
    expect(closed).toBe(true)
  })

  it('does not start reading the native response before a consumer receives permission', async () => {
    const wire = transport()
    const response = await requestThroughHost({} as Session, { url: 'https://files.example/report', method: 'GET', headers: {} }, new AbortController().signal)
    await Promise.resolve()
    expect(wire.resumed).toBe(0)
    expect(await response.text()).toBe('file bytes')
    expect(wire.resumed).toBe(1)
  })

  it.each([204, 205, 304])('releases a bodyless %i response without requiring a consumer', async (status) => {
    const wire = transport(status)
    const response = await requestThroughHost({} as Session, { url: 'https://files.example/empty', method: 'GET', headers: {} }, new AbortController().signal)
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
    expect(wire.resumed).toBe(0)
    expect(wire.aborted).toBe(true)
  })

  it('releases a HEAD response without consuming its body', async () => {
    const wire = transport()
    const response = await requestThroughHost({} as Session, { url: 'https://files.example/report', method: 'HEAD', headers: {} }, new AbortController().signal)
    expect(response.body).toBeNull()
    expect(wire.resumed).toBe(0)
    expect(wire.aborted).toBe(true)
  })

  it('aborts a native download denied after headers without resuming its body', async () => {
    const wire = transport()
    const network = new HostWebNetwork({} as Session)
    await expect(network.fetch({ url: 'https://files.example/report', method: 'GET', headers: {}, scope: 'public' }, new AbortController().signal, {
      authorize: async (_url, operation) => {
        if (operation === 'download')
          throw new Error('download denied')
      },
    })).rejects.toThrow('download denied')
    expect(wire.resumed).toBe(0)
    expect(wire.aborted).toBe(true)
  })
})
