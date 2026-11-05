import type { z } from 'zod'
import type { ExtensionImageReader } from '../../../../shared/extensions/extensionImageReading'
import type { ImageReadingInput } from '../ImageReadingService'
import type { InferenceHost } from './pluginImageFixtures'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { registerExtensionImageReadingRpc } from '../../../../electron/main/extensions/registerExtensionImageReadingRpc'
import { extensionImageReadingRequestSchema, imageReadingLimits } from '../../../../shared/extensions/extensionImageReading'
import { createPluginImageBackends } from '../createPluginImageBackends'
import { PluginImageGateway } from '../PluginImageGateway'
import { inferenceHost, pngBytes, primaryModel, readInferenceJson, rpcPair } from './pluginImageFixtures'

type ReadingRequest = z.infer<typeof extensionImageReadingRequestSchema>
const target = { kind: 'plugin', extensionId: 'fixture.reading', modelId: 'vision' } as const
const descriptor: ExtensionImageReader = {
  id: 'vision',
  title: 'Vision',
  capability: 'vision',
  support: { operations: ['understand', 'extract', 'document'] },
  extensionId: target.extensionId,
  extensionName: 'Fixture',
  revision: 'a'.repeat(64),
  bindingRevision: 'b'.repeat(64),
  generation: randomUUID(),
  managementPage: true,
}
const image = { type: 'image', mimeType: 'image/png', data: pngBytes().toString('base64') } as const

function input(overrides: Partial<ImageReadingInput> = {}): ImageReadingInput {
  return {
    operation: 'understand',
    request: 'Review the interface changes and compare selected controls.',
    question: 'Inspect the highlighted region.',
    images: [{ reference: 'fixture.png', image }],
    model: primaryModel,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function fixture(invoke?: InferenceHost['invoke']) {
  let enabled = true
  const requests: ReadingRequest[] = []
  const bindings: Array<{ extensionId: string, revision: string, generation?: string, bindingRevision?: string }> = []
  const peers = rpcPair()
  const inference = inferenceHost(async (extensionId, revision, invocation) => {
    const request = extensionImageReadingRequestSchema.parse(await readInferenceJson(invocation))
    requests.push(request)
    bindings.push({ extensionId, revision, generation: invocation.generation, bindingRevision: invocation.bindingRevision })
    if (invoke)
      return invoke(extensionId, revision, invocation)
    await invocation.ready?.()
    await invocation.event({ type: 'text', sequence: 0, text: 'A visible ' }, new Uint8Array(), invocation.signal)
    await invocation.event({ type: 'text', sequence: 1, text: 'circle.' }, new Uint8Array(), invocation.signal)
    await invocation.event({ type: 'done' }, new Uint8Array(), invocation.signal)
  })
  inference.imageReaders = async () => [descriptor]
  onTestFinished(registerExtensionImageReadingRpc(peers.host, () => inference))
  const gateway = new PluginImageGateway(peers.service)
  onTestFinished(() => gateway.dispose())
  const { reading } = createPluginImageBackends(peers.service, { isPluginModelEnabled: () => enabled }, gateway)
  return {
    reading,
    requests,
    bindings,
    disable: () => { enabled = false },
  }
}

describe('plugin image reading', () => {
  it('preserves the task, focused question, image and binding for visual understanding', async () => {
    const f = fixture()
    const request = input()
    const requestId = randomUUID()
    expect(await f.reading.candidates()).toEqual([{ target, title: 'Vision', owner: 'Fixture', available: true, managementPage: true, support: descriptor.support }])
    expect(await f.reading.read(target, request, requestId)).toEqual({ text: 'A visible circle.', title: 'Vision', owner: 'Fixture' })
    expect(f.requests).toEqual([{
      requestId,
      model: 'vision',
      operation: request.operation,
      currentUserRequest: request.request,
      question: request.question,
      image: { mimeType: image.mimeType, data: image.data },
    }])
    expect(f.bindings).toEqual([{ extensionId: descriptor.extensionId, revision: descriptor.revision, generation: descriptor.generation, bindingRevision: descriptor.bindingRevision }])
  })

  it('isolates extraction from the surrounding task while retaining its transcription query', async () => {
    const f = fixture()
    const request = input({ operation: 'extract', question: 'Transcribe the product quantities verbatim.' })
    const requestId = randomUUID()
    expect(await f.reading.read(target, request, requestId)).toEqual({ text: 'A visible circle.', title: 'Vision', owner: 'Fixture' })
    expect(f.requests).toEqual([{ requestId, model: 'vision', operation: 'extract', question: request.question, image: { mimeType: image.mimeType, data: image.data } }])
    expect(extensionImageReadingRequestSchema.safeParse({ ...f.requests[0], currentUserRequest: request.request }).success).toBe(false)
  })

  it('accepts a request without task context and a completed empty transcription', async () => {
    const f = fixture(async (_extensionId, _revision, invocation) => {
      await invocation.ready?.()
      await invocation.event({ type: 'done' }, new Uint8Array(), invocation.signal)
    })
    expect(await f.reading.read(target, input({ operation: 'extract', request: undefined }), randomUUID())).toEqual({ text: '', title: 'Vision', owner: 'Fixture' })
    expect(extensionImageReadingRequestSchema.parse({ ...f.requests[0], operation: 'understand' })).not.toHaveProperty('currentUserRequest')
  })

  it('rejects extra images without dropping them to fit the single-image protocol', async () => {
    const f = fixture()
    await expect(f.reading.read(target, input({ images: [{ reference: 'first.png', image }, { reference: 'second.png', image }] }), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_UNSUPPORTED', retryable: true })
    expect(f.requests).toEqual([])
  })

  it('projects a disabled reader as unavailable and rejects its invocation', async () => {
    const f = fixture()
    f.disable()
    expect(await f.reading.candidates()).toMatchObject([{ target, available: false }])
    await expect(f.reading.read(target, input(), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_UNSUPPORTED', retryable: true })
    expect(f.requests).toEqual([])
  })

  it.each([
    { name: 'truncated PNG', mimeType: 'image/png', data: pngBytes().subarray(0, 24).toString('base64') },
    { name: 'invalid bytes', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') },
    { name: 'MIME mismatch', mimeType: 'image/jpeg', data: image.data },
  ])('fully validates $name before the plugin receives it', async ({ mimeType, data }) => {
    const f = fixture()
    await expect(f.reading.read(target, input({ images: [{ reference: 'invalid.png', image: { type: 'image', mimeType, data } }] }), randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_MATERIALIZATION_FAILED', retryable: false })
    expect(f.requests).toEqual([])
  })

  it('counts task context in the serialized input byte limit', async () => {
    const f = fixture()
    await expect(f.reading.read(target, input({ request: '界'.repeat(Math.ceil(imageReadingLimits.inputBytes / 3)) }), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_UNSUPPORTED', retryable: true })
    expect(f.requests).toEqual([])
  })

  it.each([
    { name: 'retryable failure', events: [{ type: 'failed', code: 'BUSY', retryable: true }], retryable: true },
    { name: 'definitive failure', events: [{ type: 'failed', code: 'FAILED', retryable: false }], retryable: false },
    { name: 'missing terminal', events: [], retryable: false },
    { name: 'partial output', events: [{ type: 'text', sequence: 0, text: 'Partial' }], retryable: false },
    { name: 'failure after partial output', events: [{ type: 'text', sequence: 0, text: 'Partial' }, { type: 'failed', code: 'FAILED', retryable: true }], retryable: false },
    { name: 'duplicate terminal', events: [{ type: 'done' }, { type: 'done' }], retryable: false },
    { name: 'text after terminal', events: [{ type: 'done' }, { type: 'text', sequence: 0, text: 'Late' }], retryable: false },
    { name: 'bad sequence', events: [{ type: 'text', sequence: 1, text: 'Skipped' }, { type: 'done' }], retryable: false },
    { name: 'repeated sequence', events: [{ type: 'text', sequence: 0, text: 'First' }, { type: 'text', sequence: 0, text: 'Repeated' }, { type: 'done' }], retryable: false },
  ] as const)('does not publish incomplete or failed text: $name', async ({ events, retryable }) => {
    const f = fixture(async (_extensionId, _revision, invocation) => {
      await invocation.ready?.()
      for (const event of events)
        await invocation.event(event, new Uint8Array(), invocation.signal)
    })
    await expect(f.reading.read(target, input(), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_FAILED', retryable })
  })

  it('allows fallback for an invocation rejected before execution starts', async () => {
    const f = fixture(async () => {
      throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
    })
    await expect(f.reading.read(target, input(), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_FAILED', retryable: true })
  })

  it.each(['binary', 'utf8-budget'] as const)('rejects invalid reading output: %s', async (mode) => {
    const f = fixture(async (_extensionId, _revision, invocation) => {
      await invocation.ready?.()
      for (let sequence = 0; sequence < 3; sequence++)
        await invocation.event({ type: 'text', sequence, text: '界'.repeat(16384) }, mode === 'binary' ? Uint8Array.of(1) : new Uint8Array(), invocation.signal)
      await invocation.event({ type: 'done' }, new Uint8Array(), invocation.signal)
    })
    await expect(f.reading.read(target, input(), randomUUID())).rejects.toMatchObject({ code: 'IMAGE_READING_FAILED', retryable: false })
  })
})
