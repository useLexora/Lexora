import type { ExtensionModel } from '../../../../shared/extensions/extensionChat'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { inferenceHost, pngBytes, rpcPair } from '../../../../service/src/images/__tests__/pluginImageFixtures'
import { extensionChatMaxBytes, extensionChatRpc } from '../../../../shared/extensions/extensionChat'
import { inferenceLimits } from '../../../../shared/extensions/extensionInference'
import { registerExtensionModelRpc } from '../registerExtensionModelRpc'

const target: ExtensionModel = {
  id: 'vision',
  title: 'Vision fixture',
  capability: 'chat',
  input: ['text', 'image'],
  contextWindow: 4096,
  maxTokens: 512,
  tools: false,
  extensionId: 'fixture.models',
  extensionName: 'Fixture',
  generation: randomUUID(),
  revision: 'a'.repeat(64),
  bindingRevision: 'b'.repeat(64),
  managementPage: false,
}
const capabilities = { toolCall: false, image: true }
const image = () => ({ type: 'image', mimeType: 'image/png', data: pngBytes().toString('base64') })

it('streams ordered image messages in bounded chunks and returns validated model events', async () => {
  const peers = rpcPair()
  const chunks: Buffer[] = []
  const events: unknown[] = []
  onTestFinished(registerExtensionModelRpc(peers.host, () => inferenceHost(async (_extension, _revision, input) => {
    for await (const chunk of input.chunks ?? []) {
      expect(chunk.byteLength).toBeLessThanOrEqual(inferenceLimits.chunkBytes)
      chunks.push(Buffer.from(chunk))
    }
    await input.event({ type: 'text', text: 'Accepted image content' }, new Uint8Array(), input.signal)
    await input.event({ type: 'done', reason: 'stop', usage: { input: 1, output: 2 } }, new Uint8Array(), input.signal)
  })))
  onTestFinished(peers.service.onRequest(extensionChatRpc.event, (event) => {
    events.push(event)
    return null
  }))
  const request = {
    model: target.id,
    tools: [],
    maxTokens: 512,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'First'.repeat(inferenceLimits.chunkBytes) }, image(), { type: 'text', text: 'Second' }, image()] },
      { role: 'tool', toolCallId: 'call', name: 'read', isError: false, content: [image(), { type: 'text', text: 'Tool image' }] },
    ],
  }
  const id = randomUUID()
  expect(await peers.service.request(extensionChatRpc.invoke, { id, target, capabilities, request })).toBeNull()
  expect(chunks.length).toBeGreaterThan(1)
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(request)
  expect(events).toEqual([
    { id, event: { type: 'text', text: 'Accepted image content' } },
    { id, event: { type: 'done', reason: 'stop', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
  ])
})

it('refuses image requests when effective image support overrides the declared capability', async () => {
  const peers = rpcPair()
  onTestFinished(registerExtensionModelRpc(peers.host, () => inferenceHost(async () => {
    throw new Error('Unexpected native invocation')
  })))
  const request = { model: target.id, tools: [], maxTokens: 512, messages: [{ role: 'user', content: [image()] }] }
  expect(await peers.service.request(extensionChatRpc.invoke, { id: randomUUID(), target, capabilities: { ...capabilities, image: false }, request }))
    .toEqual({ error: 'EXTENSION_INFERENCE_INPUT_UNSUPPORTED' })
})

it('enforces the existing aggregate request budget before invoking the native backend', async () => {
  const peers = rpcPair()
  onTestFinished(registerExtensionModelRpc(peers.host, () => inferenceHost(async () => {
    throw new Error('Unexpected native invocation')
  })))
  const request = { model: target.id, tools: [], maxTokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(extensionChatMaxBytes) }, image()] }] }
  expect(await peers.service.request(extensionChatRpc.invoke, { id: randomUUID(), target, capabilities, request }))
    .toEqual({ error: 'EXTENSION_INFERENCE_CONTEXT_TOO_LARGE' })
})
