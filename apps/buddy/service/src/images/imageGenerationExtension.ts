import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type { ImageGenerationOutcome, ImageGenerationRetainedOutput, ImageRequestRef } from '../../../shared/images/imageGeneration'
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
      available: ({ model }) => Boolean(model && options.service.supports(model)),
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
      if (description && !(input.referenceIds ? description.edit : description.generate).length)
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
        const failure = readImageGenerationError(error)
        if (!failure.retainedOutputs?.length)
          executionSignal.throwIfAborted()
        return imageToolFailure(failure.code, {
          ...failure,
          outputPath,
          inspectionReferences: input.referenceIds?.some(id => id.startsWith('image:')),
        })
      }
    },
    label: 'Generate image',
    ...IMAGE_TOOLS.generate,
    parameters: parametersSchema,
    promptGuidelines: [
      'When the user asks to create or generatively edit an image, use lexora_image_generate instead of shell scripts or drawing libraries.',
      'The image generation backend cannot see chat attachments, conversation history or images inspected with lexora_image_read. For reference-based generation or editing, pass ALL user-designated images in referenceIds, using exact attachmentId or artifactId values in order. A character reference plus a pose or style reference needs both images, not only the character. Assign their roles in prompt; descriptions cannot replace the actual images. Omit referenceIds only for a new image that uses no references.',
      'For edits with references, keep prompt focused on the requested transformation and numbered image roles: preserve image 1 and apply only the requested pose or style from image 2. Do not reconstruct unchanged appearance as a text inventory or guess anatomy, colors, logos or lettering. Such guesses can override the supplied image and change the subject; the actual reference, not your paraphrase, is the source of unchanged details.',
      'A follow-up or confirmation continues the original image task and its relevant references. If IDs are missing, use lexora_image_list and explicitly select the intended images; do not switch to text-only generation. A recent result is only a candidate, not an instruction to use it. Do not guess IDs, pass paths or image: hashes, automatically include unrelated images, or use the removed reference/mode parameters.',
      'For workspace output, use a relative outputPath such as output/edited.png. A leading / means the filesystem root: do not invent /workspace or /output paths. An absolute path must be the actual intended, writable destination. The tool appends the image extension when omitted and numeric suffixes when multiple images are returned.',
      'A successful image receipt proves file creation, not visual correctness. Compare the actual output with the relevant original references before claiming character, pose or style preservation. A partial outcome with retainedOutputs means images were generated and saved, but the requested destination was not fully published: copy the retained files to an authorized destination and present them using existing file tools, keeping the originals. Do not inspect the input images to fix a local save failure. For unknown or partial outcomes, do not call image generation again or change prompt, path or references to evade the pending request.',
    ],
  })
}

function imageToolFailure(
  code: ImageGenerationErrorCode | 'VALIDATION_FAILED',
  options: {
    diagnostic?: ImageGenerationErrorDiagnostic | null
    outcome?: ImageGenerationOutcome
    request?: ImageRequestRef
    artifactIds?: string[]
    retainedOutputs?: ImageGenerationRetainedOutput[]
    outputPath?: string
    inspectionReferences?: boolean
  } = {},
) {
  const { diagnostic, outcome = 'failed', request, artifactIds = [], retainedOutputs = [], outputPath } = options
  let message: string
  if (outcome === 'partial') {
    message = retainedOutputs.length
      ? 'The provider already generated images. Local publication was incomplete, but the files listed in retainedOutputs were saved. Recover by copying those files with existing file tools to an authorized destination, then present them; keep the retained originals. This does not confirm outputPath was saved. Do not inspect the input references to repair a local save failure, and do not call lexora_image_generate again.'
      : `The provider returned a result, but local publication was incomplete. ${artifactIds.length ? 'Only the listed artifactIds identify published results.' : 'No published artifact or retained output is available in this receipt; do not claim that a generated file was saved.'} Explain the local publication failure to the user. Inspecting the input references cannot repair it. Do not automatically generate again.`
  }
  else if (outcome === 'unknown' || code === 'IMAGE_GENERATION_INCOMPLETE') {
    message = 'The provider result is unknown; do not automatically repeat this image request. Report the unresolved result rather than guessing that generation failed.'
  }
  else if (code === 'IMAGE_GENERATION_OUTPUT_UNAVAILABLE') {
    message = 'No image request was submitted: outputPath is invalid, outside the current write authorization or not writable. For workspace output use a relative path such as output/edited.png, not an invented root path such as /output/edited.png. Correct only the destination or obtain the required authorization; preserve the intended referenceIds and image requirements.'
  }
  else if (diagnostic?.fileErrorCode === 'IMAGE_MATERIAL_UNAVAILABLE') {
    message = 'No image request was submitted: the host cannot retain generated image results. This is a local host storage or capability configuration failure, not an image prompt or reference problem. Report it instead of changing referenceIds or retrying generation.'
  }
  else if (code === 'IMAGE_GENERATION_REFERENCE_UNAVAILABLE') {
    message = options.inspectionReferences
      ? 'No image request was submitted. image:<sha256> values are inspection-only handles for lexora_image_read, not generation referenceIds. Use the original attachmentId/artifactId values or lexora_image_list. Re-reading images does not create generation IDs; do not drop the intended references.'
      : 'A reference is missing, not visible on this execution branch, invalid or unreadable under the current directory permissions. No image request was submitted. Use lexora_image_list to locate exact visible attachmentId/artifactId values; do not silently drop references.'
  }
  else if (code === 'IMAGE_GENERATION_UNSUPPORTED') {
    message = 'No supported image route is available under the current policy. No image request was submitted.'
  }
  else if (code === 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' || code === 'IMAGE_GENERATION_BUSY') {
    message = 'The image backend is busy or lacks resources.'
  }
  else if (code === 'VALIDATION_FAILED') {
    message = 'Invalid image generation parameters. Use the current schema and explicit ordered referenceIds; legacy reference/mode parameters are not accepted. No image request was submitted.'
  }
  else {
    message = 'Image generation failed. Use the reported stage and error classification to distinguish generation from local file publication.'
  }
  if (code === 'IMAGE_GENERATION_BLOCKED')
    message = `No new image request was submitted because a matching request in this run is active or unresolved. ${message}`
  const details = {
    artifactIds,
    ...(retainedOutputs.length ? { retainedOutputs } : {}),
    ...(request ? { request } : {}),
    code,
    outcome,
    ...(diagnostic ? { diagnostic } : {}),
    responseId: null,
  }
  return {
    content: [{
      text: JSON.stringify({ ...details, ...(outputPath ? { outputPath } : {}), message }),
      type: 'text' as const,
    }],
    details,
  }
}
