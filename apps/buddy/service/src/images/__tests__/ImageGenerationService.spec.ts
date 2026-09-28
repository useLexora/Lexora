import type { Model } from '@earendil-works/pi-ai'
import type { ImageGenerationServiceOptions } from '../ImageGenerationService'
import type { ImageOperationEvent } from '../ImageOperationLifecycle'
import { describe, expect, it } from 'vitest'
import { ArtifactPublicationError } from '../../artifacts/ArtifactService'
import { ImageGenerationService } from '../ImageGenerationService'

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
    const source = { materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({ conversationId: 'conversation-1', cwd: '/workspace', grants: [], attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      started()

      await gate

      return [{ id: 'generated-1' }]
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }], responseId: 'private-response' }) } })
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
    await expect(pending).resolves.toEqual({ artifactIds: ['generated-1'], responseId: 'private-response' })
    await stopping
    expect(events.map(event => event.phase)).toEqual(['preparing', 'processing', 'result-received', 'publishing', 'settled'])
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', cancellationRequested: true, artifactIds: ['generated-1'] })
    expect(Object.isFrozen(events.at(-1)!.artifactIds)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private')
    await expect(service.generate({ outputPath: 'later.png', prompt: 'later' }, model, controller.signal)).rejects.toThrow('IMAGE_SERVICE_STOPPED')
  })

  it('preserves publication partial effects in image settlement', async () => {
    const source = { materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({ conversationId: 'conversation-1', cwd: '/workspace', grants: [], attachmentService: source, artifactService: { ...source, async registerGeneratedImages() {
      throw new ArtifactPublicationError(new Error('storage failed'), { operationId: 'publication-1', conversationId: 'conversation-1', cause: 'generated', requested: 2, written: 2, unconfirmedWrites: 0, artifactIds: ['generated-1'], stage: 'catalogue', outcome: 'partial' })
    } }, imageGenerationGateway: { supports: () => true, generate: async () => ({ images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }], responseId: 'private-response' }) } })
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
        async materializeConversationImages(_conversationId, ids) {
          if (ids?.[0] === 'attachment-1')
            throw Object.assign(new Error('Not an artifact'), { code: 'ARTIFACT_NOT_FOUND' })
          return { images: [{ ...image, data: ids![0]! }], records: [{ id: ids![0]! }] }
        },
        async registerGeneratedImages(input) {
          saved = input
          return [{ id: 'generated-1' }]
        },
      },
      attachmentService: {
        materializeConversationImages: async () => ({ images: [{ ...image, data: 'attachment-1' }], records: [{ id: 'attachment-1' }] }),
      },
      imageGenerationGateway: {
        supports: () => true,
        async generate(input) {
          references.push(...input.inputImages.map(item => item.data))
          return { images: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }], responseId: 'response-1' }
        },
      },
    })
    await expect(service.generate({ outputPath: ' result.png ', prompt: 'use references', reference: { mode: 'resources', resourceIds: ['artifact-1', 'attachment-1', 'artifact-2'] } }, model, new AbortController().signal)).resolves.toEqual({ artifactIds: ['generated-1'], responseId: 'response-1' })
    expect(references).toEqual(['artifact-1', 'attachment-1', 'artifact-2'])
    expect(saved).toMatchObject({ sourceArtifactId: 'artifact-2', outputPath: 'result.png', conversationId: 'conversation-1' })
  })

  it.each(['provider', 'publishing'])('does not persist generated output when cancellation precedes file publication at %s', async (phase) => {
    const controller = new AbortController()
    let saved = false
    const source = { materializeConversationImages: async () => ({ images: [], records: [] }) }
    const service = new ImageGenerationService({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: [],
      artifactService: {
        ...source,
        async registerGeneratedImages() {
          saved = true
          return [{ id: 'generated-1' }]
        },
      },
      attachmentService: source,
      imageGenerationGateway: {
        supports: () => true,
        async generate() {
          if (phase === 'provider')
            controller.abort(new Error('cancelled'))
          return { images: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }], responseId: 'response-1' }
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
