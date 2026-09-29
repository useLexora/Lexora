import type { Static, TSchema } from 'typebox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageTransformService } from './ImageTransformService'
import type { ImageTransformToolDetails } from './imageTransformToolContract'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import {
  classifyImageTransformTool,
  IMAGE_TRANSFORM_TOOL_NAME,
  readImageTransformToolDetails,
} from './imageTransformToolContract'
import { imageTransformParameters } from './imageTransformToolParameters'

type ImageTransformParameters = Static<typeof imageTransformParameters>

export function createImageTransformCapability(options: CreateImageTransformExtensionOptions): BuddyCapability {
  return {
    extension: createImageTransformExtension(options),
    classify: classifyImageTransformTool,
    workspaceMutationTools: [IMAGE_TRANSFORM_TOOL_NAME],
    disclosure: [{
      source: { kind: 'builtin', id: 'image_transform', title: 'Image transformation' },
      exposure: 'on_demand',
      keywords: 'image transform chroma 图片 处理 变换 抠图 绿幕 透明 背景',
      tools: [{ name: IMAGE_TRANSFORM_TOOL_NAME }],
    }],
  }
}

export interface CreateImageTransformExtensionOptions {
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  conversationId: string
  cwd: string
  getRunId: () => string | undefined
  grants: readonly DirectoryGrant[]
  service: Pick<ImageTransformService, 'removeChroma'>
}

export function createImageTransformExtension(
  options: CreateImageTransformExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-image-transform',
    factory(pi) {
      pi.registerTool(defineTool<TSchema, ImageTransformToolDetails>({
        description: [
          'Deterministically remove a solid chroma background from a PNG conversation artifact.',
          'Creates a new transparent PNG artifact with source lineage and preserves the original canvas.',
        ].join(' '),
        execute: async (toolCallId, parameters, signal) => {
          if (!Check(imageTransformParameters, parameters))
            return imageTransformFailure('VALIDATION_FAILED')
          const runId = options.getRunId()
          if (!runId)
            return imageTransformFailure('VALIDATION_FAILED')
          const input = parameters as ImageTransformParameters
          try {
            const artifact = await options.service.removeChroma({
              color: input.keyColor ?? '#00ff00',
              conversationId: options.conversationId,
              cwd: options.cwd,
              despill: input.despill ?? 1,
              grants: options.getExecutionGrants?.(toolCallId) ?? options.grants,
              outputPath: input.outputPath,
              softness: input.softness ?? 80,
              sourceArtifactId: input.sourceArtifactId,
              tolerance: input.tolerance ?? 60,
            }, signal)
            return {
              content: [{
                text: JSON.stringify({ artifactIds: [artifact.id], transformedCount: 1 }),
                type: 'text' as const,
              }],
              details: { artifactIds: [artifact.id] },
            }
          }
          catch (error) {
            signal?.throwIfAborted()
            return imageTransformFailure(readImageTransformErrorCode(error))
          }
        },
        label: 'Remove chroma background',
        name: IMAGE_TRANSFORM_TOOL_NAME,
        parameters: imageTransformParameters,
        promptGuidelines: [
          'When a PNG conversation artifact has a solid green-screen or other chroma background, use lexora_image_chroma_key with its artifactId instead of shell commands, interpreters, or host image packages.',
          'Set outputPath to the intended PNG path in the current workspace; use keyColor, tolerance, softness, and despill only when the defaults do not match the source.',
        ],
      }))
      pi.on('tool_result', (event) => {
        if (event.toolName !== IMAGE_TRANSFORM_TOOL_NAME)
          return
        if (readImageTransformToolDetails({ details: event.details })?.code)
          return { isError: true }
      })
    },
  }
}

function imageTransformFailure(code: string) {
  return {
    content: [{
      text: `Lexora Buddy image transformation failed: ${code}`,
      type: 'text' as const,
    }],
    details: { artifactIds: [], code },
  }
}

function readImageTransformErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : 'IMAGE_TRANSFORM_FAILED'
}
