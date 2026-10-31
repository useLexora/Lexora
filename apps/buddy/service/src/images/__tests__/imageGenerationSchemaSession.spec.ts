import type { Api, Model } from '@earendil-works/pi-ai'
import type { ImageCandidate, ImagePreferences } from '../../../../shared/images/imagePreferences'
import type { ProviderService } from '../../providers/ProviderService'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createToolDiscoveryCapability } from '../../agent/extensions/discovery/toolDiscoveryExtension'
import { createImageGenerationCapability } from '../imageGenerationExtension'
import { ImageGenerationService } from '../ImageGenerationService'
import { RoutedImageGateway } from '../RoutedImageGateway'

interface Schema { required: string[], properties: Record<string, Schema>, anyOf: Schema[], maxItems: number }

const model: Model<Api> = { api: 'openai-completions', provider: 'openai', id: 'offline-text-model', name: 'Text only', baseUrl: 'https://example.test/v1', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }

describe('generation tool schema through the public Pi extension lifecycle', () => {
  it('directly exposes the selected image model and refreshes snapshots while hiding routes that are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-image-schema-'))
    const candidates: ImageCandidate[] = [
      { target: { kind: 'plugin', extensionId: 'fixture', modelId: 'generator' }, title: 'Generate only', owner: 'Fixture', available: true, managementPage: false, support: { operations: ['generate'], maxReferenceImages: 0, sizes: ['1024x1024'], qualities: ['high'], backgrounds: ['opaque'] } },
      { target: { kind: 'plugin', extensionId: 'fixture', modelId: 'editor' }, title: 'Reference editor', owner: 'Fixture', available: true, managementPage: false, support: { operations: ['generate', 'edit'], maxReferenceImages: 2, sizes: ['auto', '1536x1024'], qualities: ['auto', 'high'], backgrounds: ['auto', 'transparent'] } },
    ]
    const select = (target: ImageCandidate['target']): ImagePreferences => ({ generate: { mode: 'selected', target, fallbacks: [] } })
    let snapshot = select(candidates[0]!.target)
    const gateway = new RoutedImageGateway({
      native: { supports: () => false, generate: async () => { throw new Error('Unexpected image request') } },
      providers: {
        listProviders: async () => [{ id: 'compatible', enabled: true, status: 'available', displayName: 'Compatible' }],
        listModels: async () => [{ id: 'custom-image', providerId: 'compatible', displayName: 'Custom image model', type: 'image-generation', api: 'openai-images', available: true, enabled: true }],
      } as unknown as ProviderService,
      plugins: { candidates: async () => candidates, generate: async () => { throw new Error('Unexpected image request') } },
      preferences: async () => select(candidates[1]!.target),
    })
    const source = { materializeConversationImages: async () => ({ images: [], records: [] }), listConversationArtifacts: () => [], listForConversation: () => [] }
    const service = new ImageGenerationService({ conversationId: 'fixture', cwd: root, grants: [], imageGenerationGateway: gateway, getImagePreferences: () => snapshot, artifactService: { ...source, registerGeneratedImages: async () => [] }, attachmentService: source })
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('openai', async () => ({ type: 'api_key', key: 'offline-only' }))
    const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false })
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } })
    const capability = createImageGenerationCapability({ getRunId: () => 'fixture-run', service })
    const discovery = createToolDiscoveryCapability(capability.disclosure ?? [])
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [capability.extension, discovery.extension] })
    await resourceLoader.reload()
    const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), model, modelRuntime: runtime, settingsManager, sessionManager: SessionManager.inMemory(root), resourceLoader })
    await session.bindExtensions({ mode: 'rpc' })
    const payloads: unknown[] = []
    session.agent.streamFunction = (target, context, options) => streamSimple(target, context, {
      ...options,
      apiKey: 'offline-only',
      fetch: async () => { throw new Error('Unexpected network request') },
      onPayload: (payload) => {
        payloads.push(payload)
        throw new Error('OFFLINE_CAPTURED')
      },
    })
    try {
      await session.prompt('Generate an image')
      snapshot = select(candidates[1]!.target)
      await session.prompt('Edit the image')
      snapshot = select({ kind: 'model', providerId: 'compatible', modelId: 'custom-image' })
      await session.prompt('Use the compatible image model')
      snapshot = {}
      await session.prompt('Continue without a configured image route')
      expect(payloads).toHaveLength(4)
      const tools = payloads.map(payload => (payload as { tools: Array<{ function: { name: string, description: string, parameters: Schema } }> }).tools.find(tool => tool.function.name === 'lexora_image_generate')?.function)
      expect(JSON.stringify(payloads[0])).toContain('When the user asks to create or generatively edit an image, use lexora_image_generate')
      expect(tools[0]!.description).toContain('Generate only: backend_declaration')
      expect(tools[0]!.description).toContain('edit [unavailable')
      expect(tools[0]!.parameters.properties.reference).toBeUndefined()
      expect(tools[0]!.parameters.required).toContain('output')
      expect(tools[0]!.parameters.properties.output!.properties.size).toMatchObject({ anyOf: [{ const: '1024x1024' }] })
      expect(tools[1]!.description).toContain('Reference editor: backend_declaration')
      expect(tools[1]!.parameters.properties.reference!.anyOf[1]!.properties.resourceIds!.maxItems).toBe(2)
      expect(tools[1]!.parameters.properties.output!.properties.background).toMatchObject({ anyOf: [{ const: 'auto' }, { const: 'transparent' }] })
      expect(tools[2]!.description).toContain('Custom image model: adapter_constraints')
      expect(tools[2]!.description).toContain('actual model capabilities are unverified')
      expect(tools[2]!.parameters.properties.reference!.anyOf[1]!.properties.resourceIds!.maxItems).toBe(4)
      expect(tools[3]).toBeUndefined()
    }
    finally {
      session.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
