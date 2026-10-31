import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ImagePreferences } from '../../../../shared/images/imagePreferences'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { ProviderService } from '../../providers/ProviderService'
import type { UsageService } from '../../usage/UsageService'
import type { ImageReadingImage, ImageReadingInput } from '../ImageReadingService'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { describe, expect, it } from 'vitest'
import { imageReadingLimits, ocrReadRequestSchema, ocrRpc } from '../../../../shared/images/ocrService'
import { ImageReadingService } from '../ImageReadingService'

const vision: Model<'openai-completions'> = { api: 'openai-completions', provider: 'vision-provider', id: 'vision', name: 'Vision', baseUrl: 'https://example.test', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const main: Model<Api> = { ...vision, provider: 'main-provider', id: 'text-main', input: ['text'] }
const selected: ImagePreferences = { understand: { mode: 'selected', target: { kind: 'model', providerId: vision.provider, modelId: vision.id }, fallbacks: [] } }
const before = png('before.png', 8, 4, 64)
const after = png('after.png', 8, 4, 192)
const legacyBmp: ImageReadingImage = { reference: 'legacy.bmp', image: { type: 'image', mimeType: 'image/bmp', data: Buffer.from('424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ff000000', 'hex').toString('base64') } }
type CompletionOptions = Parameters<ModelRuntime['completeSimple']>[2]

function fixture(options: {
  preferences?: ImagePreferences
  models?: Model<Api>[]
  complete?: (model: Model<Api>, context: Context, options: CompletionOptions) => Promise<AssistantMessage>
  ocr?: (index: number) => Promise<{ text: string }>
  payloadExtra?: string
} = {}) {
  const requests: { model: Model<Api>, context: Context }[] = []
  const usage: Parameters<UsageService['record']>[0][] = []
  const ocr: { method: string, input: unknown }[] = []
  const models = options.models ?? [vision]
  const runtime = {
    async completeSimple(model: Model<Api>, context: Context, requestOptions: CompletionOptions) {
      await requestOptions?.onPayload?.({ model: model.id, messages: context.messages, extra: options.payloadExtra }, model)
      requests.push({ model, context })
      return options.complete ? options.complete(model, context, requestOptions) : response(model)
    },
  }
  const service = new ImageReadingService({
    preferences: async () => options.preferences ?? selected,
    providers: { executionModels: { resolveSession: async ({ modelId }: { modelId: string }) => {
      const model = models.find(model => model.id === modelId)
      if (!model)
        throw new Error('Missing model')
      return { model, runtime }
    } } } as unknown as ProviderService,
    rpc: { request: async (method: string, input: unknown) => {
      ocr.push({ method, input })
      return options.ocr ? options.ocr(ocr.length - 1) : { text: `visible text ${ocr.length}` }
    } } as unknown as RuntimeRpcPeerContract,
    usage: { record: async (input) => {
      usage.push(input)
      return null
    } },
  })
  const input: ImageReadingInput = { operation: 'understand', request: 'Review the interface changes.', question: 'Compare the selected controls.', images: [before, after], model: main, runId: 'run', signal: new AbortController().signal }
  return { service, input, requests, usage, ocr }
}

describe('image reading requests', () => {
  it('sends all numbered images with the current request and focused question in one selected-model request', async () => {
    const f = fixture({ preferences: {}, models: [vision] })
    const result = await f.service.read({ ...f.input, preferences: selected })
    expect(result).toMatchObject({ kind: 'text', text: 'Image 2 has the selected control.', source: { target: selected.understand!.target, attempt: 1 } })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.context.messages[0]!.content).toEqual([
      { type: 'text', text: JSON.stringify({ currentUserRequest: f.input.request, visualQuestion: f.input.question }) },
      { type: 'text', text: 'Image 1: "before.png"' },
      before.image,
      { type: 'text', text: 'Image 2: "after.png"' },
      after.image,
    ])
    expect(f.requests[0]!.context.systemPrompt).toContain('uncertain inferences')
    expect(f.usage).toMatchObject([{ provider: vision.provider, model: vision.id, purpose: 'tool', runId: 'run', usage: { input: 100, output: 20 } }])
  })

  it('normalizes a valid image larger than the old raw-byte cutoff instead of rejecting it', async () => {
    const large = png('large.png', 1200, 1200, randomBytes(1200 * 1200 * 4))
    expect(Buffer.byteLength(large.image.data, 'base64')).toBeGreaterThan(4.5 * 1024 * 1024)
    const f = fixture()
    await f.service.read({ ...f.input, images: [large] })
    const image = requestImages(f.requests[0]!.context)[0]!
    expect(image.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
    expect(dimensions(image.data)).toEqual([1200, 1200])
    expect(large.image.mimeType).toBe('image/png')
  })

  it('isolates extraction from a conflicting user task while preserving visual task context', async () => {
    const f = fixture()
    const request = 'Compare the colors and switch states before and after; do not write separate descriptions.'
    const question = 'Transcribe the product quantities and totals verbatim.'
    for (const operation of ['extract', 'understand', 'document'] as const)
      await f.service.read({ ...f.input, request, question, operation })
    const extraction = f.requests[0]!.context
    expect(extraction.messages[0]!.content).toEqual([
      { type: 'text', text: JSON.stringify({ transcriptionQuery: question }) },
      { type: 'text', text: 'Image 1: "before.png"' },
      before.image,
      { type: 'text', text: 'Image 2: "after.png"' },
      after.image,
    ])
    expect(JSON.stringify(extraction)).not.toContain(request)
    expect(extraction.systemPrompt).toContain('extract operation takes precedence')
    expect(extraction.systemPrompt).toContain('Do not compare images, describe colors or control states')
    for (const { context } of f.requests.slice(1))
      expect(context.messages[0]!.content).toContainEqual({ type: 'text', text: JSON.stringify({ currentUserRequest: request, visualQuestion: question }) })
  })

  it('uses the same bounded normalization for native results and preserves references and resize notes', async () => {
    const model = { ...vision, inputLimits: { images: { resize: { maxWidth: 20, maxHeight: 20 } } } }
    const gif = { reference: 'animated.gif', image: { type: 'image' as const, mimeType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' } }
    const f = fixture({ preferences: {} })
    const result = await f.service.read({ ...f.input, images: [png('wide.png', 80, 40), gif], model })
    expect(result.kind).toBe('native')
    if (result.kind !== 'native')
      throw new Error('Expected native images')
    expect(result.images.map(image => image.reference)).toEqual(['wide.png', 'animated.gif'])
    expect(dimensions(result.images[0]!.image.data)).toEqual([20, 10])
    expect(result.images[0]!.note).toContain('original 80x40')
    expect(result.images[1]).toMatchObject({ image: { mimeType: 'image/png' }, note: expect.stringContaining('animation frames are not supplied') })
    expect(f.requests).toEqual([])
  })

  it('honors an explicitly selected current model as an auxiliary text request', async () => {
    const f = fixture()
    const result = await f.service.read({ ...f.input, model: vision })
    expect(result.kind).toBe('text')
    expect(requestImages(f.requests[0]!.context)).toHaveLength(2)
  })

  it('normalizes legacy BMP reads after bounded decoding', async () => {
    const f = fixture({ preferences: {} })
    const result = await f.service.read({ ...f.input, model: vision, images: [legacyBmp] })
    expect(result.kind).toBe('native')
    if (result.kind !== 'native')
      throw new Error('Expected native image')
    expect(result.images[0]).toMatchObject({ reference: 'legacy.bmp', image: { mimeType: 'image/png' } })
    expect(dimensions(result.images[0]!.image.data)).toEqual([1, 1])
  })

  it('rejects an invalid member without sending a partial image set', async () => {
    const f = fixture()
    await expect(f.service.read({ ...f.input, images: [before, { ...after, image: { ...after.image, data: Buffer.from('invalid image').toString('base64') } }] })).rejects.toMatchObject({ code: 'RESOURCE_MATERIALIZATION_FAILED' })
    expect(f.requests).toEqual([])
  })

  it.each([
    { images: [] as ImageReadingImage[], code: 'IMAGE_READING_UNSUPPORTED' },
    { images: Array.from<ImageReadingImage>({ length: imageReadingLimits.maxImages + 1 }).fill(before), code: 'MODEL_INPUT_TOO_LARGE' },
  ])('rejects an invalid batch before making a request: $code', async ({ images, code }) => {
    const f = fixture()
    await expect(f.service.read({ ...f.input, images })).rejects.toMatchObject({ code })
    expect(f.requests).toEqual([])
  })

  it.each([
    { inputLimits: { images: { maxPerMessage: 1 } } },
    { inputLimits: { maxRequestBytes: 256 } },
  ])('rejects limits without dropping comparison images', async (overrides) => {
    const f = fixture({ models: [{ ...vision, ...overrides }] })
    await expect(f.service.read(f.input)).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
    expect(f.requests).toEqual([])
  })

  it('checks the converted protocol payload before transport, including added protocol fields', async () => {
    const f = fixture({ models: [{ ...vision, inputLimits: { maxRequestBytes: 8192 } }], payloadExtra: 'x'.repeat(8192) })
    await expect(f.service.read(f.input)).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
    expect(f.requests).toEqual([])
  })

  it.each([
    { stopReason: 'length' as const, content: 'partial', code: 'IMAGE_READING_INCOMPLETE' },
    { stopReason: 'stop' as const, content: '', code: 'IMAGE_READING_INCOMPLETE' },
    { stopReason: 'aborted' as const, content: 'partial', code: 'MODEL_REQUEST_ABORTED' },
    { stopReason: 'error' as const, content: 'partial', errorMessage: '401 invalid API key', code: 'PROVIDER_AUTHENTICATION_FAILED' },
  ])('does not publish failed or incomplete reading as success: $code', async ({ stopReason, content, errorMessage, code }) => {
    const f = fixture({ complete: async model => ({ ...response(model, content), stopReason, errorMessage }) })
    await expect(f.service.read(f.input)).rejects.toMatchObject({ code })
    expect(f.usage).toHaveLength(1)
  })

  it('uses only explicit fallbacks and preserves the complete image set on retry', async () => {
    const backup = { ...vision, id: 'backup' }
    const preferences = { understand: { ...selected.understand!, fallbacks: [{ kind: 'model' as const, providerId: backup.provider, modelId: backup.id }] } }
    const f = fixture({ preferences, models: [vision, backup], complete: async model => model.id === vision.id ? { ...response(model), stopReason: 'error', errorMessage: '429 rate limit' } : response(model) })
    await expect(f.service.read(f.input)).resolves.toMatchObject({ kind: 'text', source: { target: preferences.understand.fallbacks[0], attempt: 2 } })
    expect(f.requests.map(request => request.model.id)).toEqual(['vision', 'backup'])
    expect(requestImages(f.requests[0]!.context)).toEqual(requestImages(f.requests[1]!.context))
  })

  it('propagates cancellation after a provider response without publishing text or retrying', async () => {
    const controller = new AbortController()
    const f = fixture({ complete: async (model) => {
      controller.abort(new Error('cancelled by user'))
      return response(model)
    } })
    await expect(f.service.read({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled by user')
    expect(f.requests).toHaveLength(1)
    expect(f.usage).toHaveLength(1)
  })
})

describe('independent OCR image batches', () => {
  const preferences: ImagePreferences = { ocrEnabled: true, ocrService: { api: 'paddleocr', endpoint: 'https://example.test/ocr' } }

  it('labels every OCR result in original order, including an image with no text', async () => {
    const f = fixture({ preferences, ocr: async index => ({ text: index ? '' : 'invoice 42' }) })
    const result = await f.service.read({ ...f.input, operation: 'extract' })
    expect(result).toMatchObject({ kind: 'text', text: 'Image 1: "before.png"\ninvoice 42\n\nImage 2: "after.png"\n[No visible text.]', source: { target: { kind: 'ocr', api: 'paddleocr' } } })
    expect(f.ocr).toEqual([before, after].map(({ image }) => ({ method: ocrRpc.read, input: { service: preferences.ocrService, image: { data: image.data, mimeType: image.mimeType } } })))
  })

  it('fails the batch if a later OCR request fails instead of returning only earlier text', async () => {
    const f = fixture({ preferences, ocr: async (index) => {
      if (index)
        throw new Error('OCR unavailable')
      return { text: 'first page only' }
    } })
    await expect(f.service.read({ ...f.input, operation: 'extract' })).rejects.toMatchObject({ code: 'IMAGE_READING_FAILED' })
    expect(f.ocr).toHaveLength(2)
  })

  it('converts BMP into a supported OCR format without changing its source reference', async () => {
    const f = fixture({ preferences })
    const result = await f.service.read({ ...f.input, operation: 'extract', images: [legacyBmp] })
    expect(result).toMatchObject({ kind: 'text', text: 'Image 1: "legacy.bmp"\nvisible text 1' })
    const request = ocrReadRequestSchema.parse(f.ocr[0]!.input)
    expect(request.image.mimeType).toBe('image/png')
    expect(dimensions(request.image.data)).toEqual([1, 1])
  })
})

function response(model: Model<Api>, text = 'Image 2 has the selected control.'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}

function requestImages(context: Context) {
  return context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : [])
}

function png(reference: string, width: number, height: number, pixels: number | Uint8Array = 255): ImageReadingImage {
  const image = new PhotonImage(typeof pixels === 'number' ? new Uint8Array(width * height * 4).fill(pixels) : pixels, width, height)
  try {
    return { reference, image: { type: 'image', mimeType: 'image/png', data: Buffer.from(image.get_bytes()).toString('base64') } }
  }
  finally { image.free() }
}

function dimensions(data: string): number[] {
  const image = PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'))
  try {
    return [image.get_width(), image.get_height()]
  }
  finally { image.free() }
}
