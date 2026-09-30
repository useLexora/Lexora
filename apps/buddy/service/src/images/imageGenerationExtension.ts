import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Static, TSchema } from 'typebox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageGenerationErrorCode, ImageGenerationErrorDiagnostic } from './ImageGenerationGateway'
import type { ImageGenerationService } from './ImageGenerationService'
import type { ImageGenerationToolDetails } from './imageGenerationToolContract'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import { readImageGenerationError } from './ImageGenerationGateway'
import { classifyImageGenerationTool, IMAGE_GENERATION_TOOL_NAME, readImageGenerationToolDetails } from './imageGenerationToolContract'
import { imageGenerationParameters } from './imageGenerationToolParameters'

export interface CreateImageGenerationExtensionOptions {
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  getRunId: () => string | undefined
  service: Pick<ImageGenerationService, 'generate' | 'supports'>
}

export function createImageGenerationCapability(options: CreateImageGenerationExtensionOptions): BuddyCapability {
  return {
    extension: createImageGenerationExtension(options),
    classify: classifyImageGenerationTool,
    workspaceMutationTools: [IMAGE_GENERATION_TOOL_NAME],
    disclosure: [{
      source: { kind: 'builtin', id: 'image_generation', title: 'Image generation' },
      exposure: 'on_demand',
      keywords: 'image generate edit picture draw 图片 生成 绘制 画图 编辑 修改',
      tools: [{ name: IMAGE_GENERATION_TOOL_NAME }],
      available: ({ model }) => Boolean(model && options.service.supports(model)),
    }],
  }
}

export function createImageGenerationExtension(
  options: CreateImageGenerationExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-image-generation',
    factory(pi) {
      pi.registerTool(createImageGenerationTool(options))
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

function createImageGenerationTool(options: CreateImageGenerationExtensionOptions): ToolDefinition {
  return defineTool<TSchema, ImageGenerationToolDetails>({
    description: [
      'Generate or edit an image with the active model.',
      'Use reference.mode=resources for exact attachment or artifact ids, or reference.mode=latest for the latest image in this conversation.',
      'Generated images are saved and shown in the Lexora Buddy conversation immediately.',
    ].join(' '),
    execute: async (toolCallId, parameters, signal, _onUpdate, context) => {
      if (!Check(imageGenerationParameters, parameters) || !options.getRunId())
        return imageToolFailure('VALIDATION_FAILED')
      const input = parameters as Static<typeof imageGenerationParameters>
      const outputPath = input.outputPath.trim()
      if (!outputPath || outputPath === '.' || outputPath === '..')
        return imageToolFailure('VALIDATION_FAILED')
      const model = context.model
      if (!model || !options.service.supports(model))
        return imageToolFailure('IMAGE_GENERATION_UNSUPPORTED')
      const executionSignal = signal ?? new AbortController().signal
      try {
        const result = await options.service.generate(input, model, executionSignal, options.getExecutionGrants?.(toolCallId))
        return {
          content: [{
            text: JSON.stringify({ artifactIds: result.artifactIds, generatedCount: result.artifactIds.length }),
            type: 'text' as const,
          }],
          details: result,
        }
      }
      catch (error) {
        executionSignal.throwIfAborted()
        const failure = readImageGenerationError(error)
        return imageToolFailure(failure.code, failure.diagnostic)
      }
    },
    label: 'Generate image',
    name: IMAGE_GENERATION_TOOL_NAME,
    parameters: imageGenerationParameters,
    promptGuidelines: [
      'When the user asks to create or generatively edit an image, use lexora_image_generate instead of shell scripts or drawing libraries.',
      'With lexora_image_generate, when the user refers to an image already in the conversation, use reference.mode=resources with its attachmentId or artifactId, or reference.mode=latest.',
      'With lexora_image_generate, set outputPath to the intended path in the current workspace. The tool appends the image extension when omitted and numeric suffixes when one call returns multiple images.',
    ],
  })
}

function imageToolFailure(
  code: ImageGenerationErrorCode | 'VALIDATION_FAILED',
  diagnostic: ImageGenerationErrorDiagnostic | null = null,
) {
  const diagnosticText = diagnostic
    ? Object.entries(diagnostic).map(([key, value]) => `${key}=${value}`).join(', ')
    : ''
  const recovery = code === 'IMAGE_GENERATION_INCOMPLETE'
    ? '. The provider result is unknown; do not automatically repeat this image request.'
    : ''
  return {
    content: [{
      text: `Lexora Buddy image generation failed: ${code}${diagnosticText ? ` (${diagnosticText})` : ''}${recovery}`,
      type: 'text' as const,
    }],
    details: {
      artifactIds: [],
      code,
      ...(diagnostic ? { diagnostic } : {}),
      responseId: null,
    },
  }
}
