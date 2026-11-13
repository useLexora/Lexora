import type { Model } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationServiceOptions } from '../ImageGenerationService'
import { Buffer } from 'node:buffer'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createImageGenerationExtension } from '../imageGenerationExtension'
import { ImageGenerationError } from '../ImageGenerationGateway'
import { ImageGenerationMaterialStore } from '../ImageGenerationMaterialStore'
import { ImageGenerationService } from '../ImageGenerationService'
import {
  classifyImageGenerationTool,
  IMAGE_GENERATION_TOOL_NAME,
} from '../imageGenerationToolContract'
import { createImagePublicationFixture } from './imagePublicationFixture'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'lexora-image-tool-')))
const publication = createImagePublicationFixture(workspace)
afterAll(async () => {
  await publication.dispose()
  rmSync(workspace, { recursive: true, force: true })
})
const workspaceContext = {
  cwd: workspace,
  grants: [{
    canonicalRoot: workspace,
    grantId: 'workspace-1',
    kind: 'workspace' as const,
    root: workspace,
  }],
}

describe('imageGenerationExtension', () => {
  it('generates from explicit references and returns artifact handles', async () => {
    const materializeConversationImages = vi.fn(async () => ({
      images: [{
        data: png.toString('base64'),
        mimeType: 'image/png' as const,
        type: 'image' as const,
      }],
      records: [{ id: 'reference-1' }],
    }))
    const registerGeneratedImages = vi.fn(async () => [{
      id: 'generated-1',
      currentPath: join(workspace, 'images/像素风角色.png'),
      mimeType: 'image/png',
    }])
    const generate = vi.fn(async () => ({
      images: [{ bytes: new Uint8Array(png), mimeType: 'image/png' as const }],
      responseId: 'response-1',
    }))
    let tool: ToolDefinition | undefined
    const extension = createTestImageExtension({
      ...workspaceContext,
      artifactService: {
        materializeConversationImages,
        registerGeneratedImages,
      },
      attachmentService: {
        materializeConversationImages: vi.fn(),
      },
      conversationId: 'conversation-1',
      getRunId: () => 'run-1',
      imageGenerationGateway: {
        generate,
        supports: () => true,
      },
    })
    extension.factory({
      getActiveTools: () => [IMAGE_GENERATION_TOOL_NAME],
      on: () => {},
      registerTool: (registered: ToolDefinition) => tool = registered,
      setActiveTools: () => {},
    } as never)

    expect(tool).toBeDefined()
    const execute = (tool as ToolDefinition).execute as unknown as (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      context: { model: Model<'openai-responses'> },
    ) => Promise<unknown>
    await expect(execute('tool-call-1', {
      outputPath: 'images/像素风角色.png',
      prompt: 'Turn the reference into Q-style pixel art',
      referenceIds: ['reference-1'],
    }, new AbortController().signal, undefined, { model: openAiModel() })).resolves.toMatchObject({
      content: [{ type: 'text' }],
      details: {
        artifactIds: ['generated-1'],
        responseId: 'response-1',
      },
    })
    expect(materializeConversationImages).toHaveBeenCalledWith('conversation-1', ['reference-1'], { ...workspaceContext, signal: expect.any(AbortSignal) })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      inputImages: [expect.objectContaining({ mimeType: 'image/png' })],
      prompt: 'Turn the reference into Q-style pixel art',
    }))
    expect(registerGeneratedImages).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants: workspaceContext.grants,
      images: [expect.objectContaining({ mimeType: 'image/png' })],
      outputPath: 'images/像素风角色.png',
      sourceArtifactId: 'reference-1',
    }), publication.writeFiles)
  })

  it.each([
    { reference: { mode: 'latest' } },
    { reference: { mode: 'resources', resourceIds: ['reference-1'] } },
    { referenceIds: [] },
    { referenceIds: ['reference-1', 'reference-1'] },
  ])('rejects invalid reference selection before submitting: %j', async (selection) => {
    let tool: ToolDefinition | undefined
    let submitted = 0
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { supports: () => true, generate: async () => {
        submitted++
        return { artifactIds: [], outputs: [], responseId: null }
      } },
    }).factory({ on: () => {}, registerTool: (registered: ToolDefinition) => tool = registered } as never)
    const result = await tool!.execute!('legacy-call', { outputPath: 'result.png', prompt: 'Edit the image', ...selection }, undefined, undefined, { model: openAiModel() } as never)
    expect(result.details).toMatchObject({ code: 'VALIDATION_FAILED', outcome: 'failed', artifactIds: [] })
    expect(submitted).toBe(0)
  })

  it('declares image generation as a first-party artifact write', () => {
    expect(IMAGE_GENERATION_TOOL_NAME).toBe('lexora_image_generate')
    expect(classifyImageGenerationTool({
      input: { outputPath: 'images/result' },
      toolName: IMAGE_GENERATION_TOOL_NAME,
    })).toEqual({
      access: 'write',
      paths: [{ mode: 'create', path: 'images/result' }],
    })
    expect(classifyImageGenerationTool({ input: {}, toolName: 'read' })).toBeNull()
  })

  it('returns the unavailable route and failed outcome as model-visible facts', async () => {
    let tool: ToolDefinition | undefined
    const generate = vi.fn()
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { generate, supports: () => false },
    }).factory({
      on: () => {},
      registerTool: (registered: ToolDefinition) => tool = registered,
    } as never)
    const result = await tool!.execute!('tool-call-1', {
      outputPath: 'image.png',
      prompt: 'Create an image',
    }, undefined, undefined, { model: openAiModel() } as never)
    expect(result.details).toMatchObject({ code: 'IMAGE_GENERATION_UNSUPPORTED', artifactIds: [] })
    const content = result.content[0]!
    expect(content.type).toBe('text')
    expect(JSON.parse(content.type === 'text' ? content.text : '')).toMatchObject({ code: 'IMAGE_GENERATION_UNSUPPORTED', outcome: 'failed', artifactIds: [], message: expect.stringContaining('No supported image route is available under the current policy. No image request was submitted.') })
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    ['IMAGE_GENERATION_REFERENCE_UNAVAILABLE', 'failed', 'No image request was submitted'],
    ['IMAGE_GENERATION_OUTPUT_UNAVAILABLE', 'failed', 'preserve the intended referenceIds'],
    ['IMAGE_GENERATION_INVALID_RESPONSE', 'unknown', 'do not automatically repeat'],
    ['IMAGE_GENERATION_BLOCKED', 'unknown', 'No new image request was submitted'],
  ] as const)('distinguishes preparation failure from an unknown provider result: %s', async (code, outcome, recovery) => {
    let tool: ToolDefinition | undefined
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { supports: () => true, generate: async () => { throw new ImageGenerationError(code, { cause: new Error('private body'), outcome }) } },
    }).factory({ on: () => {}, registerTool: (registered: ToolDefinition) => tool = registered } as never)
    const result = await tool!.execute!('fixture-call', { outputPath: 'image.png', prompt: 'Create' }, undefined, undefined, { model: openAiModel() } as never)
    expect(result.details).toMatchObject({ code, outcome, artifactIds: [] })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(recovery) }])
    expect(JSON.stringify(result)).not.toContain('private body')
  })

  it.each(['IMAGE_GENERATION_FAILED', 'IMAGE_GENERATION_BLOCKED'] as const)('provides copy-only recovery of retained results without disguising publication failure: %s', async (code) => {
    const retainedOutputs = [{ path: join(workspace, '.image-generation', 'result.png'), mimeType: 'image/png' as const, sizeBytes: png.length, sha256: 'a'.repeat(64) }]
    let tool: ToolDefinition | undefined
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { supports: () => true, generate: async () => {
        throw new ImageGenerationError(code, { outcome: 'partial', diagnostic: { stage: 'publishing', fileErrorCode: 'EACCES' }, retainedOutputs, cause: new Error('private filesystem error') })
      } },
    }).factory({ on: () => {}, registerTool: (registered: ToolDefinition) => tool = registered } as never)
    const result = await tool!.execute!('publication-call', { outputPath: 'output/image.png', prompt: 'Preserve image 1' }, undefined, undefined, { model: openAiModel() } as never)
    expect(result.details).toMatchObject({ code, outcome: 'partial', artifactIds: [], retainedOutputs, diagnostic: { fileErrorCode: 'EACCES' } })
    const content = result.content[0]!
    expect(content.type).toBe('text')
    expect(JSON.parse(content.type === 'text' ? content.text : '')).toMatchObject({
      outputPath: 'output/image.png',
      retainedOutputs,
      message: expect.stringContaining('Recover by copying those files'),
    })
    expect(JSON.stringify(result)).toContain('do not call lexora_image_generate again')
    expect(JSON.stringify(result)).not.toContain('private filesystem error')
  })

  it.each([
    { code: 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE' as const, diagnostic: undefined, referenceIds: [`image:${'a'.repeat(64)}`], message: 'inspection-only handles for lexora_image_read' },
    { code: 'IMAGE_GENERATION_FAILED' as const, diagnostic: { stage: 'preparing' as const, fileErrorCode: 'IMAGE_MATERIAL_UNAVAILABLE' as const }, referenceIds: undefined, message: 'the host cannot retain generated image results' },
  ])('identifies the actual preparation problem instead of suggesting image reinterpretation: $code', async ({ code, diagnostic, referenceIds, message }) => {
    let tool: ToolDefinition | undefined
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { supports: () => true, generate: async () => { throw new ImageGenerationError(code, { outcome: 'failed', diagnostic }) } },
    }).factory({ on: () => {}, registerTool: (registered: ToolDefinition) => tool = registered } as never)
    const result = await tool!.execute!('preparation-call', { outputPath: 'image.png', prompt: 'Preserve the reference', ...(referenceIds ? { referenceIds } : {}) }, undefined, undefined, { model: openAiModel() } as never)
    expect(result.details).toMatchObject({ code, outcome: 'failed' })
    expect(JSON.stringify(result.content)).toContain(message)
    expect(JSON.stringify(result.content)).toContain('No image request was submitted')
  })

  it('does not imply that an unpublished legacy result has an available retained file', async () => {
    let tool: ToolDefinition | undefined
    createImageGenerationExtension({
      getRunId: () => 'run-1',
      service: { supports: () => true, generate: async () => { throw new ImageGenerationError('IMAGE_GENERATION_FAILED', { outcome: 'partial' }) } },
    }).factory({ on: () => {}, registerTool: (registered: ToolDefinition) => tool = registered } as never)
    const result = await tool!.execute!('legacy-call', { outputPath: 'image.png', prompt: 'Create' }, undefined, undefined, { model: openAiModel() } as never)
    expect(JSON.stringify(result.content)).toContain('No published artifact or retained output is available in this receipt')
    expect(result.details).not.toHaveProperty('retainedOutputs')
  })

  it('returns safe provider diagnostics to the model', async () => {
    let tool: ToolDefinition | undefined
    createTestImageExtension({
      ...workspaceContext,
      artifactService: emptyArtifactService(),
      attachmentService: {
        materializeConversationImages: vi.fn(),
      },
      conversationId: 'conversation-1',
      getRunId: () => 'run-1',
      imageGenerationGateway: {
        generate: async () => {
          throw new ImageGenerationError('IMAGE_GENERATION_FAILED', {
            diagnostic: {
              providerCode: 'invalid_value',
              providerParameter: 'tools[0].background',
              requestId: 'req_image_1',
            },
          })
        },
        supports: () => true,
      },
    }).factory({
      getActiveTools: () => [IMAGE_GENERATION_TOOL_NAME],
      on: () => {},
      registerTool: (registered: ToolDefinition) => tool = registered,
      setActiveTools: () => {},
    } as never)

    const execute = (tool as ToolDefinition).execute as unknown as (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      context: { model: Model<'openai-responses'> },
    ) => Promise<{
      content: Array<{ text: string }>
      details: Record<string, unknown>
    }>
    const result = await execute('tool-call-1', {
      outputPath: '新图片.png',
      prompt: 'Create a new image',
    }, new AbortController().signal, undefined, { model: openAiModel() })

    expect(result.details).toMatchObject({
      code: 'IMAGE_GENERATION_FAILED',
      diagnostic: {
        providerCode: 'invalid_value',
        providerParameter: 'tools[0].background',
        requestId: 'req_image_1',
      },
    })
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'IMAGE_GENERATION_FAILED', outcome: 'failed', diagnostic: result.details.diagnostic })
  })
})

function emptyArtifactService() {
  return {
    materializeConversationImages: vi.fn(async () => ({ images: [], records: [] })),
    registerGeneratedImages: vi.fn(async () => []),
  }
}

function openAiModel(): Model<'openai-responses'> {
  return {
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'gpt-5.6-sol',
    input: ['text', 'image'],
    maxTokens: 16_384,
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    reasoning: true,
  }
}

function createTestImageExtension(options: Omit<ImageGenerationServiceOptions, 'referenceAccess'> & { getRunId: () => string | undefined }) {
  const materials = new ImageGenerationMaterialStore(options.cwd, options.conversationId)
  return createImageGenerationExtension({ createFileWriter: () => publication.writeFiles, getRunId: options.getRunId, service: new ImageGenerationService({ ...options, writeGeneratedImageMaterial: (image, grants, writeFiles, signal) => materials.write(image, grants, writeFiles, signal), referenceAccess: { authorize: () => {} } }) })
}
