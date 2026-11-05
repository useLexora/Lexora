import type { ExtensionImageEvent, ExtensionImageModel, ExtensionImageRequest } from '../../../../shared/extensions/extensionImage'
import type { ImageGenerationInput } from '../ImageGenerationGateway'
import type { InferenceHost } from './pluginImageFixtures'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { registerExtensionImageRpc } from '../../../../electron/main/extensions/registerExtensionImageRpc'
import { extensionImageRequestSchema } from '../../../../shared/extensions/extensionImage'
import { addedExtensionPermissions, extensionManifestSchema } from '../../../../shared/extensions/extensionManifest'
import { nativeImageSupport } from '../imageGenerationSupport'
import { PluginImageGateway } from '../PluginImageGateway'
import { inferenceHost, pngBytes, primaryModel, readInferenceJson, rpcPair } from './pluginImageFixtures'

const descriptor: ExtensionImageModel = {
  id: 'image',
  title: 'Image',
  capability: 'image',
  support: nativeImageSupport,
  extensionId: 'fixture.image',
  extensionName: 'Fixture',
  revision: 'a'.repeat(64),
  bindingRevision: 'b'.repeat(64),
  generation: randomUUID(),
  managementPage: true,
}
const png = pngBytes()
const submitted: ExtensionImageEvent = { type: 'submitted', requestId: 'backend-42' }
const imageEvent: ExtensionImageEvent = { type: 'image', index: 0, sequence: 0, final: true, mimeType: 'image/png' }
const done: ExtensionImageEvent = { type: 'done', responseId: 'result-42' }

function input(overrides: Partial<ImageGenerationInput> = {}): ImageGenerationInput {
  return { model: primaryModel, prompt: 'A blue circle.', inputImages: [], signal: new AbortController().signal, ...overrides }
}

function fixture(invoke: InferenceHost['invoke']) {
  const peers = rpcPair()
  const inference = inferenceHost(invoke)
  inference.imageModels = async () => [descriptor]
  onTestFinished(registerExtensionImageRpc(peers.host, () => inference))
  const gateway = new PluginImageGateway(peers.service)
  onTestFinished(() => gateway.dispose())
  return gateway
}

describe('plugin image generation protocol', () => {
  it.each(['generate', 'edit'] as const)('preserves %s input and assembles ordered binary output over RPC', async (operation) => {
    const requests: ExtensionImageRequest[] = []
    const submittedIds: string[] = []
    const gateway = fixture(async (extensionId, revision, invocation) => {
      expect({ extensionId, revision, generation: invocation.generation, bindingRevision: invocation.bindingRevision }).toEqual({ extensionId: descriptor.extensionId, revision: descriptor.revision, generation: descriptor.generation, bindingRevision: descriptor.bindingRevision })
      requests.push(extensionImageRequestSchema.parse(await readInferenceJson(invocation)))
      await invocation.ready?.()
      await invocation.event(submitted, new Uint8Array(), invocation.signal)
      for (let index = 0; index < 2; index++) {
        await invocation.event({ ...imageEvent, index, sequence: 0, final: false }, png.subarray(0, 16), invocation.signal)
        await invocation.event({ ...imageEvent, index, sequence: 1, final: true }, png.subarray(16), invocation.signal)
      }
      await invocation.event(done, new Uint8Array(), invocation.signal)
    })
    const requestId = randomUUID()
    const request = input({
      requestId,
      output: { size: '1024x1024', background: 'transparent', quality: 'high' },
      inputImages: operation === 'edit' ? [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] : [],
      onSubmitted: async (id) => { submittedIds.push(id) },
    })
    expect(await gateway.models()).toEqual([descriptor])
    expect(await gateway.generate(descriptor, request)).toEqual({ responseId: 'result-42', images: [{ bytes: png, mimeType: 'image/png' }, { bytes: png, mimeType: 'image/png' }] })
    expect(submittedIds).toEqual(['backend-42'])
    expect(requests).toEqual([{ requestId, model: descriptor.id, operation, prompt: request.prompt, images: request.inputImages.map(({ mimeType, data }) => ({ mimeType, data })), output: request.output }])
  })

  const malformed: Array<{ name: string, events: Array<{ event: ExtensionImageEvent, bytes?: Uint8Array }> }> = [
    { name: 'missing terminal', events: [{ event: imageEvent, bytes: png }] },
    { name: 'terminal without images', events: [{ event: done }] },
    { name: 'partial failure', events: [{ event: imageEvent, bytes: png }, { event: { type: 'failed', code: 'FAILED', retryable: true } }] },
    { name: 'duplicate terminal', events: [{ event: imageEvent, bytes: png }, { event: done }, { event: done }] },
    { name: 'bad sequence', events: [{ event: { ...imageEvent, sequence: 1 }, bytes: png }] },
    { name: 'bad image index', events: [{ event: { ...imageEvent, index: 1 }, bytes: png }] },
    { name: 'repeated sequence', events: [{ event: { ...imageEvent, final: false }, bytes: png }, { event: imageEvent, bytes: png }] },
    { name: 'image after final chunk', events: [{ event: imageEvent, bytes: png }, { event: { ...imageEvent, sequence: 1 }, bytes: png }] },
    { name: 'unfinished image', events: [{ event: { ...imageEvent, final: false }, bytes: png }, { event: done }] },
    { name: 'next image before final chunk', events: [{ event: { ...imageEvent, final: false }, bytes: png }, { event: { ...imageEvent, index: 1 }, bytes: png }] },
    { name: 'empty image chunk', events: [{ event: imageEvent }, { event: done }] },
    { name: 'invalid PNG signature', events: [{ event: imageEvent, bytes: Buffer.from('not a PNG') }, { event: done }] },
    { name: 'binary terminal', events: [{ event: imageEvent, bytes: png }, { event: done, bytes: Uint8Array.of(1) }] },
  ]

  it.each(malformed)('keeps $name as unknown and non-retryable', async ({ events }) => {
    const gateway = fixture(async (_extensionId, _revision, invocation) => {
      await invocation.ready?.()
      await invocation.event(submitted, new Uint8Array(), invocation.signal)
      for (const { event, bytes = new Uint8Array() } of events)
        await invocation.event(event, bytes, invocation.signal)
    })
    await expect(gateway.generate(descriptor, input())).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INCOMPLETE', outcome: 'unknown', retryable: false, diagnostic: { requestId: 'backend-42' } })
  })

  it.each([
    { reason: 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED', code: 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' },
    { reason: 'EXTENSION_REQUEST_LIMIT', code: 'IMAGE_GENERATION_BUSY' },
    { reason: 'EXTENSION_INFERENCE_PROCESS_EXITED', code: 'IMAGE_GENERATION_FAILED' },
  ])('distinguishes pre-execution rejection from uncertain execution: $reason', async ({ reason, code }) => {
    for (const started of [false, true]) {
      const gateway = fixture(async (_extensionId, _revision, invocation) => {
        if (started)
          await invocation.ready?.()
        throw new Error(reason)
      })
      await expect(gateway.generate(descriptor, input())).rejects.toMatchObject(started
        ? { code: 'IMAGE_GENERATION_INCOMPLETE', retryable: false, outcome: 'unknown', diagnostic: { providerCode: reason === 'EXTENSION_REQUEST_LIMIT' ? 'EXTENSION_INFERENCE_BUSY' : reason } }
        : { code, retryable: true, outcome: 'failed' })
    }
  })

  it.each([
    { code: 'RESOURCE_EXHAUSTED', retryable: true, expected: 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' },
    { code: 'BUSY', retryable: true, expected: 'IMAGE_GENERATION_BUSY' },
    { code: 'FAILED', retryable: false, expected: 'IMAGE_GENERATION_FAILED' },
    { code: 'UNSUPPORTED', retryable: false, expected: 'IMAGE_GENERATION_UNSUPPORTED' },
  ] as const)('preserves an explicit terminal failure without fabricating output: $code', async ({ code, retryable, expected }) => {
    const gateway = fixture(async (_extensionId, _revision, invocation) => {
      await invocation.ready?.()
      await invocation.event(submitted, new Uint8Array(), invocation.signal)
      await invocation.event({ type: 'failed', code, retryable }, new Uint8Array(), invocation.signal)
    })
    await expect(gateway.generate(descriptor, input())).rejects.toMatchObject({ code: expected, outcome: 'failed', retryable, diagnostic: { requestId: 'backend-42', providerCode: code } })
  })

  it('rejects GPU inference without its separately reviewed permission', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'fixture.image',
      name: 'Fixture',
      version: '1.0.0',
      apiVersion: 3,
      engines: { lexora: '*' },
      entry: 'entry.js',
      permissions: { inference: true },
      contributes: { inference: { runtimes: [{ id: 'image', entry: 'native/image.mjs', platforms: ['linux-x64'], gpu: true }], capabilities: [{ id: 'image', title: 'Image', kind: 'image.generate', runtime: 'image' }] } },
    }
    expect(extensionManifestSchema.safeParse(manifest).success).toBe(false)
    const allowed = extensionManifestSchema.parse({ ...manifest, permissions: { inference: true, inferenceGpu: true } })
    expect(addedExtensionPermissions(undefined, allowed.permissions)).toContain('inferenceGpu')
  })
})
