import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { proxySettingsSchema } from '../../../../shared/network/proxySettings'
import { OutboundProxy, resolveUpstreamProxy, toElectronProxyConfig } from '../OutboundProxy'

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => {
    server.closeAllConnections()
    return new Promise<void>(resolve => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}

function get(proxy: OutboundProxy, url: string, authenticated = true) {
  return new Promise<{ status: number, body: string }>((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port: proxy.port,
      path: url,
      agent: false,
      headers: authenticated ? { 'proxy-authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } : {},
    }, (response) => {
      let body = ''
      response.on('data', chunk => body += chunk)
      response.on('end', () => resolve({ status: response.statusCode!, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('outbound proxy', () => {
  it('can clean up before listening and after repeated shutdown', async () => {
    const proxy = new OutboundProxy(async () => 'DIRECT')
    await expect(proxy.stop()).resolves.toBeUndefined()
    await expect(proxy.stop()).resolves.toBeUndefined()
    const started = new OutboundProxy(async () => 'DIRECT')
    await started.start()
    expect(started.port).toBeGreaterThan(0)
    await expect(started.stop()).resolves.toBeUndefined()
    await expect(started.stop()).resolves.toBeUndefined()
  })
  it.each([
    ['lexora', '[::1]:443', 'https://[::1]:443/'],
    ['lexora-http', 'fixture.invalid:80', 'http://fixture.invalid:80/'],
  ])('resolves CONNECT destinations for %s with their original protocol', async (username, authority, expectedUrl) => {
    const destinations: string[] = []
    const proxy = new OutboundProxy(async (url) => {
      destinations.push(url)
      return ''
    })
    await proxy.start()
    cleanups.push(() => proxy.stop())
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({
        hostname: '127.0.0.1',
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        agent: false,
        headers: { 'proxy-authorization': `Basic ${Buffer.from(`${username}:${proxy.password}`).toString('base64')}` },
      })
      outgoing.on('connect', (response, socket) => {
        socket.destroy()
        resolve(response.statusCode!)
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(status).toBe(502)
    expect(destinations).toEqual([expectedUrl])
  })

  it('forwards through SOCKS5 with remote hostname resolution and preserves the response body', async () => {
    let target = ''
    const socks = createTcpServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([5, 0]))
        socket.once('data', (chunk) => {
          const connect = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          expect(connect[3]).toBe(3)
          target = connect.subarray(5, 5 + connect[4]!).toString()
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
          socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nsocks-body!'))
        })
      })
    })
    socks.listen(0, '127.0.0.1')
    await once(socks, 'listening')
    cleanups.push(() => new Promise<void>(resolve => socks.close(() => resolve())))
    const port = (socks.address() as { port: number }).port
    const proxy = new OutboundProxy(async () => `SOCKS5 127.0.0.1:${port}`)
    await proxy.start()
    cleanups.push(() => proxy.stop())
    expect(await get(proxy, 'http://fixture.invalid/stream')).toEqual({ status: 200, body: 'socks-body!' })
    expect(target).toBe('fixture.invalid')
  })

  it('routes actual requests through the selected upstream and switches to direct without forwarding local authentication', async () => {
    const requests: string[] = []
    const originPort = await listen(createServer((req, res) => {
      expect(req.headers['proxy-authorization']).toBeUndefined()
      res.end('direct')
    }))
    const upstreamPort = await listen(createServer((req, res) => {
      requests.push(req.url!)
      expect(req.headers['proxy-authorization']).toBeUndefined()
      res.end('upstream')
    }))
    let route = `PROXY 127.0.0.1:${upstreamPort}`
    const proxy = new OutboundProxy(async () => route)
    await proxy.start()
    cleanups.push(() => proxy.stop())
    const target = `http://127.0.0.1:${originPort}/stream`
    expect(await get(proxy, target)).toEqual({ status: 200, body: 'upstream' })
    route = 'DIRECT'
    proxy.disconnect()
    expect(await get(proxy, target)).toEqual({ status: 200, body: 'direct' })
    expect(requests).toEqual([target])
    expect((await get(proxy, target, false)).status).toBe(407)
  })

  it('fails closed on invalid resolution and rejects a connection to itself', async () => {
    const proxy = new OutboundProxy(async () => '')
    await proxy.start()
    cleanups.push(() => proxy.stop())
    expect((await get(proxy, 'http://fixture.invalid/')).status).toBe(502)
    expect((await get(proxy, proxy.address)).status).toBe(502)
  })

  it('rejects a route resolved before a mode change instead of sending it through the previous proxy', async () => {
    let resolveRoute!: (route: string) => void
    let started!: () => void
    const routing = new Promise<void>(resolve => started = resolve)
    const proxy = new OutboundProxy(() => {
      started()
      return new Promise<string>(resolve => resolveRoute = resolve)
    })
    await proxy.start()
    cleanups.push(() => proxy.stop())
    const response = get(proxy, 'http://fixture.invalid/')
    await routing
    proxy.disconnect()
    resolveRoute('DIRECT')
    await expect(response).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('preserves the selected protocol and does not silently fall back to direct', () => {
    expect(resolveUpstreamProxy('SOCKS5 localhost:1080; DIRECT')).toBe('socks5h://localhost:1080')
    expect(resolveUpstreamProxy('HTTPS proxy.invalid:443')).toBe('https://proxy.invalid:443')
    expect(resolveUpstreamProxy('DIRECT')).toBeUndefined()
    expect(() => resolveUpstreamProxy('UNKNOWN example:1; DIRECT')).toThrow()
    expect(toElectronProxyConfig({ mode: 'direct', server: 'http://localhost:7890' })).toEqual({ mode: 'direct' })
    expect(toElectronProxyConfig({ mode: 'system', server: '' })).toEqual({ mode: 'system' })
    expect(toElectronProxyConfig({ mode: 'custom', server: 'socks5://localhost:1080' })).toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://localhost:1080' })
  })

  it.each(['', 'ftp://localhost:21', 'http://user:secret@localhost:7890', 'http://localhost:7890/path', 'http://localhost:7890?token=secret', 'http://localhost:99999'])('rejects invalid custom proxy configuration: %s', (server) => {
    expect(proxySettingsSchema.safeParse({ mode: 'custom', server }).success).toBe(false)
  })
})
