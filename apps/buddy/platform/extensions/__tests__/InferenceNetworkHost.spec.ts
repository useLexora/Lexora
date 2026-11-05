import type { RequestListener } from 'node:http'
import type { InferenceNetworkRequest } from '../InferenceNetworkHost'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'
import { InferenceNetworkClient } from '../inferenceNetworkClient'
import { InferenceNetworkHost } from '../InferenceNetworkHost'
import { inferenceFrame, readInferenceFrames } from '../inferenceWire'

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal

function channel(request: InferenceNetworkRequest, onUpload?: () => void) {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const abort = new AbortController()
  const host = new InferenceNetworkHost(outbound, request)
  const client = new InferenceNetworkClient(async (message, bytes) => {
    inbound.write(inferenceFrame(message, bytes))
    if (message.type === 'network.input')
      onUpload?.()
  })
  const reading = (async () => {
    for await (const { message, bytes } of readInferenceFrames(inbound))
      host.receive(message.id!, message, bytes, abort.signal)
  })()
  const replying = (async () => {
    for await (const { message, bytes } of readInferenceFrames(outbound))
      client.receive(message, bytes)
  })()
  onTestFinished(async () => {
    abort.abort()
    await host.close()
    inbound.end()
    outbound.end()
    await Promise.all([reading, replying])
  })
  return { client, host }
}

async function serve(listener: RequestListener) {
  const server = createServer(listener)
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener')
  return `http://127.0.0.1:${address.port}`
}

it('preserves multipart files and response bytes across framed chunks, including the backend request ID', async () => {
  const source = randomBytes(2 * 1024 * 1024 + 7)
  const second = new Uint8Array([8, 5, 3])
  const received: Array<{ hashes: string[], prompt: ReturnType<FormData['get']> }> = []
  const origin = await serve(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const bytes of request)
        chunks.push(bytes)
      const form = await new Request('http://127.0.0.1/upload', {
        method: 'POST',
        headers: { 'content-type': request.headers['content-type']! },
        body: Buffer.concat(chunks),
      }).formData()
      const images = form.getAll('image[]')
      const hashes = await Promise.all(images.map(async (image) => {
        if (typeof image === 'string')
          throw new Error('Expected a multipart file')
        return hash(new Uint8Array(await image.arrayBuffer()))
      }))
      received.push({ hashes, prompt: form.get('prompt') })
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-request-id': 'server-image-1' })
      response.end(source)
    }
    catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })
  const { client } = channel(async (_name, body, signal, options) => fetch(`${origin}/upload`, {
    method: 'POST',
    body: Buffer.from(body),
    headers: { 'content-type': options!.contentType! },
    signal,
    redirect: 'manual',
  }))
  const form = new FormData()
  form.append('prompt', 'preserve original')
  form.append('image[]', new Blob([source], { type: 'image/png' }), 'reference.png')
  form.append('image[]', new Blob([second], { type: 'image/png' }), 'second.png')
  const serialized = new Request(origin, { method: 'POST', body: form })
  const response = await client.post(randomUUID(), 'images', new Uint8Array(await serialized.arrayBuffer()), signal(), {
    contentType: serialized.headers.get('content-type')!,
  })
  expect(response.headers.get('x-request-id')).toBe('server-image-1')
  expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(hash(source))
  expect(received).toEqual([{ hashes: [hash(source), hash(second)], prompt: 'preserve original' }])
})

it('cancels an incomplete upload before submission and frees capacity for the next call', async () => {
  const abort = new AbortController()
  const submitted: Uint8Array[] = []
  const { client, host } = channel(async (_name, body) => {
    submitted.push(body)
    return new Response(Buffer.from(body))
  }, () => abort.abort())
  await expect(client.post(randomUUID(), 'images', new Uint8Array(inferenceLimits.chunkBytes + 1), abort.signal)).rejects.toThrow('NETWORK_CANCELLED')
  await host.close()
  expect(submitted).toEqual([])
  const response = await client.post(randomUUID(), 'images', new Uint8Array([7, 8]), signal())
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7, 8]))
  expect(submitted).toEqual([new Uint8Array([7, 8])])
})

it('does not retry an accepted POST after a response disconnect or follow a redirect', async () => {
  const submitted: string[] = []
  const { client, host } = channel(async (name) => {
    submitted.push(name)
    if (name === 'redirect')
      return new Response('moved', { status: 307, headers: { location: 'https://other.invalid' } })
    let pulled = false
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled)
          controller.error(new Error('connection lost'))
        else
          controller.enqueue(new Uint8Array([1, 2]))
        pulled = true
      },
    }), { headers: { 'x-request-id': 'accepted-before-disconnect' } })
  })
  const response = await client.post(randomUUID(), 'broken', new Uint8Array(), signal())
  expect(response.headers.get('x-request-id')).toBe('accepted-before-disconnect')
  await expect(response.arrayBuffer()).rejects.toThrow('NETWORK_FAILED')
  await host.close()
  await expect(client.post(randomUUID(), 'redirect', new Uint8Array(), signal())).rejects.toThrow('NETWORK_FAILED')
  expect(submitted).toEqual(['broken', 'redirect'])
})

it('rejects oversized requests, foreign owners and out-of-order chunks before submitting bytes', async () => {
  const submitted: Uint8Array[] = []
  const { client, host } = channel(async (_name, body) => {
    submitted.push(body)
    return new Response('unexpected')
  })
  expect(() => client.post(randomUUID(), 'images', new Uint8Array(inferenceLimits.networkRequestBytes + 1), signal())).toThrow('NETWORK_LIMIT')
  const requestId = randomUUID()
  const owner = randomUUID()
  host.receive(owner, { type: 'network.request', data: { requestId, endpoint: 'images', size: 2 } }, new Uint8Array(), signal())
  expect(() => host.receive(randomUUID(), { type: 'network.input', data: { requestId, offset: 0 } }, new Uint8Array([1, 2]), signal())).toThrow('NETWORK_UNAVAILABLE')
  expect(() => host.receive(owner, { type: 'network.input', data: { requestId, offset: 1 } }, new Uint8Array([1]), signal())).toThrow('PROTOCOL_INVALID')
  await host.close()
  expect(submitted).toEqual([])
})

it('cancels one real HTTP stream without terminating a concurrent invocation', async () => {
  const origin = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    if (request.url === '/held')
      response.write('accepted')
    else
      response.end('survivor')
  })
  const { client } = channel(async (name, body, signal) => fetch(`${origin}/${name}`, {
    method: 'POST',
    body: Buffer.from(body),
    signal,
    redirect: 'manual',
  }))
  const abort = new AbortController()
  const held = await client.post(randomUUID(), 'held', new Uint8Array(), abort.signal)
  const reader = held.body!.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('accepted')
    const surviving = client.post(randomUUID(), 'other', new Uint8Array(), signal())
    abort.abort()
    await expect(reader.read()).rejects.toThrow('NETWORK_CANCELLED')
    expect(await (await surviving).text()).toBe('survivor')
  }
  finally {
    abort.abort()
    reader.releaseLock()
  }
})
