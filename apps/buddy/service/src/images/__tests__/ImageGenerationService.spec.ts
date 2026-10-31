import type { Model } from '@earendil-works/pi-ai'
import type { ImageGenerationServiceOptions } from '../ImageGenerationService'
import type { ImageOperationEvent } from '../ImageOperationLifecycle'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { ArtifactPublicationError } from '../../artifacts/ArtifactService'
import { ImageGenerationService } from '../ImageGenerationService'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
const image = { type: 'image' as const, mimeType: 'image/png', data: 'fixture' }
const model = { provider: 'fixture', id: 'fixture' } as Model<'openai-responses'>

describe('conversation image generation', () => {
  it('settles accepted publication with actual artifacts after cancellation and drains disposal', async () => {
    const controller = new AbortController()
    let release!: () => void
    let started!: () => void
    const publicationStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({ conversationId: 'conversation-1', cwd: '/workspace', grants: [], attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      started()

      await gate

      return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'private-response' }) } })
    const events: ImageOperationEvent[] = []
    service.onDidChange(event => events.push(event))
    const pending = service.generate({ outputPath: 'private.png', prompt: 'private prompt' }, model, controller.signal)
    await publicationStarted
    controller.abort()
    let disposed = false
    const stopping = service.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await expect(pending).resolves.toEqual({ artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'private-response' })
    await stopping
    expect(events.map(event => event.phase)).toEqual(['preparing', 'processing', 'result-received', 'publishing', 'settled'])
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', cancellationRequested: true, artifactIds: ['generated-1'] })
    expect(Object.isFrozen(events.at(-1)!.artifactIds)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private')
    await expect(service.generate({ outputPath: 'later.png', prompt: 'later' }, model, controller.signal)).rejects.toThrow('IMAGE_SERVICE_STOPPED')
  })

  it('preserves publication partial effects in image settlement', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({ conversationId: 'conversation-1', cwd: '/workspace', grants: [], attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      throw new ArtifactPublicationError(new Error('storage failed'), { operationId: 'publication-1', conversationId: 'conversation-1', cause: 'generated', requested: 2, written: 2, unconfirmedWrites: 0, artifactIds: ['generated-1'], stage: 'catalogue', outcome: 'partial' })
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'private-response' }) } })
    const events: ImageOperationEvent[] = []
    service.onDidChange(event => events.push(event))
    await expect(service.generate({ outputPath: 'private.png', prompt: 'private prompt' }, model, new AbortController().signal)).rejects.toMatchObject({ receipt: { outcome: 'partial' } })
    expect(events.at(-1)).toMatchObject({ phase: 'settled', outcome: 'partial', artifactIds: ['generated-1'], publication: { written: 2, operationId: 'publication-1' } })
    await service.dispose()
  })

  it('preserves reference order and uses the last artifact reference for lineage', async () => {
    const references: string[] = []
    let saved: Parameters<ImageGenerationServiceOptions['artifactService']['registerGeneratedImages']>[0] | undefined
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      artifactService: {
        listConversationArtifacts: () => [],
        async materializeConversationImages(_conversationId, ids) {
          if (ids?.[0] === 'attachment-1')
            throw Object.assign(new Error('Not an artifact'), { code: 'ARTIFACT_NOT_FOUND' })
          return { images: [{ ...image, data: ids![0]! }], records: [{ id: ids![0]! }] }
        },
        async registerGeneratedImages(input) {
          saved = input
          return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
        },
      },
      attachmentService: {
        listForConversation: () => [],
        materializeConversationImages: async () => ({ images: [{ ...image, data: 'attachment-1' }], records: [{ id: 'attachment-1' }] }),
      },
      imageGenerationGateway: {
        supports: () => true,
        async generate(input) {
          references.push(...input.inputImages.map(item => item.data))
          return { images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' }
        },
      },
    })
    await expect(service.generate({ outputPath: ' result.png ', prompt: 'use references', reference: { mode: 'resources', resourceIds: ['artifact-1', 'attachment-1', 'artifact-2'] } }, model, new AbortController().signal)).resolves.toEqual({ artifactIds: ['generated-1'], outputs: [{ artifactId: 'generated-1', path: '/workspace/result.png', mimeType: 'image/png' }], responseId: 'response-1' })
    expect(references).toEqual(['artifact-1', 'attachment-1', 'artifact-2'])
    expect(saved).toMatchObject({ sourceArtifactId: 'artifact-2', outputPath: 'result.png', conversationId: 'conversation-1' })
  })

  it.each([
    ['2026-10-31T00:00:00Z', '2026-10-31T00:01:00Z', 'attachment-1'],
    ['2026-10-31T00:02:00Z', '2026-10-31T00:01:00Z', 'artifact-1'],
    ['2026-10-31T00:01:00Z', '2026-10-31T00:01:00Z', 'attachment-1'],
    ['', '2026-10-31T00:01:00Z', 'attachment-1'],
  ])('uses the newest updated artifact or attachment for latest: %s / %s', async (artifactTime, attachmentTime, expected) => {
    const read: string[] = []
    let generatedReferences: string[] = []
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      artifactService: {
        listConversationArtifacts: () => [{ id: 'artifact-1', kind: 'file', mimeType: 'image/png', createdAt: artifactTime, updatedAt: artifactTime }],
        materializeConversationImages: async (_conversationId, ids) => {
          if (ids?.[0] !== 'artifact-1')
            throw Object.assign(new Error('Missing'), { code: 'ARTIFACT_NOT_FOUND' })
          read.push('artifact-1')
          return { images: [{ ...image, data: 'artifact-1' }], records: [{ id: 'artifact-1' }] }
        },
        registerGeneratedImages: async () => [{ id: 'result', currentPath: '/workspace/actual-2.png', mimeType: 'image/png' }],
      },
      attachmentService: {
        listForConversation: () => [{ id: 'attachment-1', mimeType: 'image/png', createdAt: attachmentTime }],
        materializeConversationImages: async () => {
          read.push('attachment-1')
          return { images: [{ ...image, data: 'attachment-1' }], records: [{ id: 'attachment-1' }] }
        },
      },
      imageGenerationGateway: { supports: () => true, generate: async (input) => {
        generatedReferences = input.inputImages.map(image => image.data)
        return { images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: null }
      } },
    })
    const result = await service.generate({ outputPath: 'requested.png', prompt: 'Edit latest', reference: { mode: 'latest' } }, model, new AbortController().signal)
    expect(read).toEqual([expected])
    expect(generatedReferences).toEqual([expected])
    expect(result.outputs).toEqual([{ artifactId: 'result', path: '/workspace/actual-2.png', mimeType: 'image/png' }])
  })

  it('reports inaccessible references as a known failure before sending an image request', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => {
      throw Object.assign(new Error('private path and provider body'), { code: 'DIRECTORY_NOT_AUTHORIZED' })
    } }
    let submitted = false
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      attachmentService: source,
      artifactService: { ...source, registerGeneratedImages: async () => [] },
      imageGenerationGateway: { supports: () => true, generate: async () => {
        submitted = true
        return { images: [], responseId: null }
      } },
    })
    await expect(service.generate({ outputPath: 'result.png', prompt: 'Edit', reference: { mode: 'resources', resourceIds: ['restricted-reference'] } }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE', outcome: 'failed', retryable: false })
    expect(submitted).toBe(false)
  })

  it('rejects a PNG signature without decodable pixels before publication with unknown outcome', async () => {
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    let published = false
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      attachmentService: source,
      artifactService: { ...source, registerGeneratedImages: async () => {
        published = true
        return []
      } },
      imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), mimeType: 'image/png' }], responseId: null }) },
    })
    await expect(service.generate({ outputPath: 'result.png', prompt: 'Create' }, model, new AbortController().signal)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INVALID_RESPONSE', outcome: 'unknown', retryable: false })
    expect(published).toBe(false)
  })

  it.each(['provider', 'publishing'])('does not persist generated output when cancellation precedes file publication at %s', async (phase) => {
    const controller = new AbortController()
    let saved = false
    const source = { listConversationArtifacts: () => [], listForConversation: () => [], materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      artifactService: {
        ...source,
        async registerGeneratedImages() {
          saved = true
          return [{ id: 'generated-1', currentPath: '/workspace/result.png', mimeType: 'image/png' }]
        },
      },
      attachmentService: source,
      imageGenerationGateway: {
        supports: () => true,
        async generate() {
          if (phase === 'provider')
            controller.abort(new Error('cancelled'))
          return { images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' }], responseId: 'response-1' }
        },
      },
    })
    service.onDidChange((event) => {
      if (phase === 'publishing' && event.phase === 'publishing')
        controller.abort(new Error('cancelled'))
    })
    await expect(service.generate({ outputPath: 'result.png', prompt: 'generate' }, model, controller.signal)).rejects.toThrow('cancelled')
    expect(saved).toBe(false)
  })
})
