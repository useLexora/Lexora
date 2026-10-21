import type { Session } from 'electron'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { HostWebNetwork } from '../HostWebNetwork'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function networkFixture() {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(req.url!)
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://denied.example/final' })
      res.end()
    }
    else { res.end('actual response') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('server address missing')
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const network = new HostWebNetwork({} as Session, async (_session, input, signal) => {
    const url = new URL(input.url)
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, { redirect: 'manual', signal })
  })
  return { network, received }
}

const request = (url: string) => ({ url, method: 'GET' as const, scope: 'public' as const, headers: {} })

describe('network request boundary', () => {
  it('does not connect to an initially denied target', async () => {
    const { network, received } = await networkFixture()
    await expect(network.fetch(request('https://denied.example/start'), new AbortController().signal, {
      authorize: async () => { throw new Error('denied') },
    })).rejects.toThrow('denied')
    expect(received).toEqual([])
  })

  it('connects to an approved first hop but never sends the denied redirect', async () => {
    const { network, received } = await networkFixture()
    const authorized: string[] = []
    await expect(network.fetch(request('https://allowed.example/redirect'), new AbortController().signal, {
      authorize: async (url) => {
        authorized.push(url)
        if (new URL(url).hostname === 'denied.example')
          throw new Error('denied redirect')
      },
    })).rejects.toThrow('denied redirect')
    expect(received).toEqual(['/redirect'])
    expect(authorized).toEqual(['https://allowed.example/redirect', 'https://denied.example/final'])
  })

  it('waits for a download decision before pulling a recognized file body and cancels on denial', async () => {
    let pulled = 0
    let cancelled = false
    const network = new HostWebNetwork({} as Session, async () => new Response(new ReadableStream({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/pdf' } }))
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<void>()
    const running = network.fetch(request('https://files.example/document'), new AbortController().signal, {
      authorize: async (_url, operation) => {
        if (operation === 'download') {
          started.resolve()
          await decision.promise
          throw new Error('download denied')
        }
      },
    })
    const rejected = expect(running).rejects.toThrow('download denied')
    await started.promise
    expect(pulled).toBe(0)
    decision.resolve()
    await rejected
    expect(pulled).toBe(0)
    expect(cancelled).toBe(true)
  })

  it('actually consumes a recognized file only after both access and download approval', async () => {
    const operations: string[] = []
    const network = new HostWebNetwork({} as Session, async () => new Response('file bytes', { headers: { 'content-disposition': 'attachment; filename=report.txt' } }))
    const result = await network.fetch(request('https://files.example/document'), new AbortController().signal, {
      authorize: async (_url, operation) => { operations.push(operation!) },
    })
    expect(await result.response.text()).toBe('file bytes')
    expect(operations).toEqual(['access', 'download'])
  })

  it('rechecks cancellation after a delayed allow before connecting', async () => {
    const { network, received } = await networkFixture()
    const controller = new AbortController()
    await expect(network.fetch(request('https://allowed.example/start'), controller.signal, {
      authorize: async () => { controller.abort() },
    })).rejects.toThrow()
    expect(received).toEqual([])
  })
})
