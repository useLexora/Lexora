import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'
import type { CapturedFileWriterFactory } from '../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageGenerationDescription, ImageGenerationErrorCode, ImageGenerationErrorDiagnostic } from './ImageGenerationGateway'
import type { GenerateConversationImageInput, ImageGenerationService } from './ImageGenerationService'
import type { ImageGenerationToolDetails } from './imageGenerationToolContract'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import { readImageGenerationError } from './ImageGenerationGateway'
import { classifyImageGenerationTool, IMAGE_GENERATION_TOOL_NAME, readImageGenerationToolDetails } from './imageGenerationToolContract'
import { createImageGenerationParameters, describeImageGeneration } from './imageGenerationToolParameters'
import { IMAGE_TOOLS } from './imageToolGroup'

export interface CreateImageGenerationExtensionOptions {
  createFileWriter?: CapturedFileWriterFactory
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  getRunId: () => string | undefined
  service: Pick<ImageGenerationService, 'generate' | 'supports'> & Partial<Pick<ImageGenerationService, 'describe'>>
}

interface ImageGenerationToolState {
  description?: ImageGenerationDescription
}

export function createImageGenerationCapability(options: CreateImageGenerationExtensionOptions): BuddyCapability {
  const state: ImageGenerationToolState = {}
  return {
    extension: createImageGenerationExtension(options, state),
    classify: classifyImageGenerationTool,
    mutationEffect: event => event.toolName === IMAGE_GENERATION_TOOL_NAME ? { kind: 'none' } : null,
    disclosure: [{
      source: { kind: 'builtin', id: 'image_generation', title: 'Image generation' },
      exposure: 'direct',
      keywords: 'image generate edit picture draw 图片 生成 绘制 画图 编辑 修改',
      tools: [IMAGE_TOOLS.generate],
      available: ({ model }) => Boolean(model && options.service.supports(model) && (!state.description || state.description.generate.length || state.description.edit.length)),
    }],
  }
}

export function createImageGenerationExtension(
  options: CreateImageGenerationExtensionOptions,
  state: ImageGenerationToolState = {},
): BuddyInProcessExtension {
  return {
    name: 'lexora-image-generation',
    factory(pi) {
      pi.registerTool(createImageGenerationTool(options))
      const refresh = async (context: ExtensionContext) => {
        if (!context.model)
          return
        try {
          state.description = await options.service.describe?.(context.model, context.signal)
          pi.registerTool(createImageGenerationTool(options, state.description))
        }
        catch (error) {
          state.description = { generate: [], edit: [] }
          pi.registerTool(createImageGenerationTool(options, state.description))
          throw error
        }
      }
      pi.on('before_agent_start', (_event, context) => refresh(context))
      pi.on('model_select', (_event, context) => refresh(context))
      pi.on('tool_result', (event) => {
        if (event.toolName !== IMAGE_GENERATION_TOOL_NAME)
          return
        const details = readImageGenerationToolDetails({ details: event.details })
        if (details?.code)
          return { isError: true }
      })
    },
  }
}

function createImageGenerationTool(options: CreateImageGenerationExtensionOptions, description?: ImageGenerationDescription): ToolDefinition {
  const parametersSchema = createImageGenerationParameters(description)
  return defineTool<TSchema, ImageGenerationToolDetails>({
    description: describeImageGeneration(description),
    execute: async (toolCallId, parameters, signal, _onUpdate, context) => {
      if (!Check(parametersSchema, parameters) || !options.getRunId())
        return imageToolFailure('VALIDATION_FAILED')
      const input = parameters as unknown as GenerateConversationImageInput
      if (description && !(input.reference ? description.edit : description.generate).length)
        return imageToolFailure('IMAGE_GENERATION_UNSUPPORTED')
      const outputPath = input.outputPath.trim()
      if (!outputPath || outputPath === '.' || outputPath === '..')
        return imageToolFailure('VALIDATION_FAILED')
      const model = context.model
      if (!model || !options.service.supports(model))
        return imageToolFailure('IMAGE_GENERATION_UNSUPPORTED')
      const executionSignal = signal ?? new AbortController().signal
      try {
        const result = await options.service.generate(input, model, executionSignal, options.getExecutionGrants?.(toolCallId), options.createFileWriter?.({ type: 'tool_call', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, input: parameters as Record<string, unknown>, signal: executionSignal }), { runId: options.getRunId()!, toolCallId })
        return {
          content: [{
            text: JSON.stringify({ artifactIds: result.artifactIds, generatedCount: result.artifactIds.length, outputs: result.outputs, ...(result.source ? { source: result.source } : {}) }),
            type: 'text' as const,
          }],
          details: result,
        }
      }
      catch (error) {
        executionSignal.throwIfAborted()
        const failure = readImageGenerationError(error)
        return imageToolFailure(failure.code, failure.diagnostic, failure.outcome)
      }
    },
    label: 'Generate image',
    ...IMAGE_TOOLS.generate,
    parameters: parametersSchema,
    promptGuidelines: [
      'When the user asks to create or generatively edit an image, use lexora_image_generate instead of shell scripts or drawing libraries.',
      'With lexora_image_generate, use reference only when the current schema includes it. For an image already in the conversation, use reference.mode=resources with its attachmentId or artifactId, or reference.mode=latest. Explicit ids are preferable when multiple images are present. In the prompt assign a role to each ordered reference, describe the changes and the elements to preserve.',
      'With lexora_image_generate, set outputPath to the intended path in the current workspace. The tool appends the image extension when omitted and numeric suffixes when one call returns multiple images.',
      'A successful lexora_image_generate receipt proves that an image file was created, not that its appearance meets the request. Use the returned outputs[].path with lexora_image_read when a visual check is needed; do not claim visual verification from a receipt alone. Do not automatically repeat a request whose outcome is unknown.',
    ],
  })
}

function imageToolFailure(
  code: ImageGenerationErrorCode | 'VALIDATION_FAILED',
  diagnostic: ImageGenerationErrorDiagnostic | null = null,
  outcome: 'failed' | 'unknown' = 'failed',
) {
  const diagnosticText = diagnostic
    ? Object.entries(diagnostic).map(([key, value]) => `${key}=${value}`).join(', ')
    : ''
  const recovery = outcome === 'unknown' || code === 'IMAGE_GENERATION_INCOMPLETE'
    ? '. The provider result is unknown; do not automatically repeat this image request.'
    : code === 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE'
      ? '. The reference is missing, invalid or unreadable under the current directory permissions. No image request was submitted. Resolve the reference or its access before trying again.'
      : code === 'IMAGE_GENERATION_UNSUPPORTED'
        ? '. The selected model, authentication method or channel does not support image generation. Do not automatically switch accounts or billing routes.'
        : code === 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' || code === 'IMAGE_GENERATION_BUSY'
          ? '. The image backend is busy or lacks resources. Do not automatically repeat this request, stop other models, or reduce the requested image requirements. Ask the user to adjust the backend or retry later.'
          : ''
  return {
    content: [{
      text: `Lexora Buddy image generation failed: ${code}${diagnosticText ? ` (${diagnosticText})` : ''}${recovery}`,
      type: 'text' as const,
    }],
    details: {
      artifactIds: [],
      code,
      outcome,
      ...(diagnostic ? { diagnostic } : {}),
      responseId: null,
    },
  }
}
