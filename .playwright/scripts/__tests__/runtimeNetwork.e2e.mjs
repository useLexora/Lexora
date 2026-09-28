import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { expect, test } from '../fixtures/electron.mjs'

test('runtime stops connecting after a proxy drops its tunnel handshake and remains usable', async ({ buddy }, testInfo) => {
  const sockets = new Set()
  let failedConnections = 0
  const authorizations = []
  const origin = createServer((request, response) => {
    if (request.url === '/pending') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: pending\n\n')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
    response.end(gzipSync('data: recovered\n\ndata: [DONE]\n\n'))
  })
  origin.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81, 5, ...Buffer.from('ready')]))
    socket.on('data', () => socket.end(Buffer.from([0x88, 0])))
  })
  origin.on('connection', trackSocket)
  const proxy = createServer()
  function trackSocket(socket) {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }
  proxy.on('connection', trackSocket)
  proxy.on('connect', (request, socket, head) => {
    authorizations.push(request.headers['proxy-authorization'])
    if (request.url === 'fixture.invalid:443') {
      failedConnections++
      socket.destroy()
      return
    }
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    trackSocket(upstream)
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const instance = await buddy.createInstance('network')
    const { app } = await instance.launch()
    const result = await app.evaluate(async ({ utilityProcess }, { fixture, port }) => {
      const proxyUrl = `http://fixture:dummy@127.0.0.1:${port}`
      const child = utilityProcess.fork(fixture, [], {
        env: { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
        stdio: 'pipe',
      })
      try {
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Network fixture timed out')), 5000)
          child.once('message', (message) => {
            clearTimeout(timeout)
            resolve(message)
          })
          child.once('exit', (code) => {
            clearTimeout(timeout)
            reject(new Error(`Network fixture exited: ${code}`))
          })
        })
      }
      finally { child.kill() }
    }, { fixture: path.resolve('.playwright/scripts/__tests__/runtimeNetworkUtility.mjs'), port: proxy.address().port })
    await testInfo.attach('network-lifecycle', { body: JSON.stringify({ ...result, failedConnections }), contentType: 'application/json' })
    console.log(JSON.stringify({ ...result, failedConnections }))
    expect(result).toMatchObject({ failure: { name: 'TypeError', code: 'UND_ERR_PRX_CONN' }, stream: 'data: recovered\n\ndata: [DONE]\n\n', responseCompatible: true, websocket: 'ready', cancelled: true })
    expect(failedConnections).toBe(1)
    expect(new Set(authorizations)).toEqual(new Set([`Basic ${Buffer.from('fixture:dummy').toString('base64')}`]))
  }
  finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => proxy.close(resolve))
    await new Promise(resolve => origin.close(resolve))
  }
})

test('built runtime terminates failed proxy requests and can restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('network-runtime')
  const { app, page } = await instance.launch()
  await app.evaluate(() => {
    const { Server } = process.getBuiltinModule('node:http')
    const emit = Server.prototype.emit
    const probe = { connections: 0, restore: () => Server.prototype.emit = emit }
    globalThis.networkFixture = probe
    Server.prototype.emit = function (event, ...args) {
      if (event === 'connect' && args[0].url === 'models.dev:443') {
        probe.connections++
        args[1].destroy()
        return true
      }
      return Reflect.apply(emit, this, [event, ...args])
    }
  })
  try {
    const refresh = () => page.evaluate(() => window.lexoraDesktop.localChat.providers.refreshModelSnapshot())
    expect(await refresh()).toMatchObject({ errorCount: 1, source: 'builtin' })
    await delay(400)
    expect(await app.evaluate(() => globalThis.networkFixture.connections)).toBe(1)
    expect(await refresh()).toMatchObject({ errorCount: 1 })
    await delay(400)
    expect(await app.evaluate(() => globalThis.networkFixture.connections)).toBe(2)
    await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
    await expect.poll(() => page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).toMatchObject({ status: 'ready' })
    expect(await refresh()).toMatchObject({ errorCount: 1 })
    await delay(400)
    expect(await app.evaluate(() => globalThis.networkFixture.connections)).toBe(3)
  }
  finally {
    await app.evaluate(() => {
      globalThis.networkFixture.restore()
      delete globalThis.networkFixture
    })
  }
})
