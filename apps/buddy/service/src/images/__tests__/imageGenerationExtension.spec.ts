import type { Model } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationServiceOptions } from '../ImageGenerationService'
import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'
import { createImageGenerationExtension } from '../imageGenerationExtension'
import { ImageGenerationError } from '../ImageGenerationGateway'
import { ImageGenerationService } from '../ImageGenerationService'
import {
  classifyImageGenerationTool,
  IMAGE_GENERATION_TOOL_NAME,
} from '../imageGenerationToolContract'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const workspaceContext = {
  cwd: '/workspace',
  grants: [{
    canonicalRoot: '/workspace',
    grantId: 'workspace-1',
    kind: 'workspace' as const,
    root: '/workspace',
  }],
}

describe('imageGenerationExtension', () => {
  it('generates from the latest conversation image and returns immutable artifact handles', async () => {
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
      reference: { mode: 'latest' },
    }, new AbortController().signal, undefined, { model: openAiModel() })).resolves.toMatchObject({
      content: [{ type: 'text' }],
      details: {
        artifactIds: ['generated-1'],
        responseId: 'response-1',
      },
    })
    expect(materializeConversationImages).toHaveBeenCalledWith('conversation-1')
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      inputImages: [expect.objectContaining({ mimeType: 'image/png' })],
      prompt: 'Turn the reference into Q-style pixel art',
    }))
    expect(registerGeneratedImages).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      cwd: '/workspace',
      grants: workspaceContext.grants,
      images: [expect.objectContaining({ mimeType: 'image/png' })],
      outputPath: 'images/像素风角色.png',
      sourceArtifactId: 'reference-1',
    }), undefined)
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

  it('rejects unavailable authentication with a clear no-account-switch recovery message', async () => {
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
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('authentication method or channel does not support image generation') }])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Do not automatically switch accounts or billing routes') }])
    expect(generate).not.toHaveBeenCalled()
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
    expect(result.content[0]?.text).toContain('providerParameter=tools[0].background')
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

function createTestImageExtension(options: ImageGenerationServiceOptions & { getRunId: () => string | undefined }) {
  return createImageGenerationExtension({ getRunId: options.getRunId, service: new ImageGenerationService(options) })
}
