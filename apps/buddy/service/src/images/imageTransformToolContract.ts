import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { BuddyRunOutputPayload } from '../../../shared/runs/runOutput'
import type { BuddyToolClassificationResult } from '../approvals/toolClassification'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import { Check } from 'typebox/value'
import { createToolClassificationFailure } from '../approvals/toolClassification'
import { readRecord } from '../events/toolPresentationSupport'
import { IMAGE_TOOLS } from './imageToolGroup'
import { imageTransformParameters } from './imageTransformToolParameters'

export const IMAGE_TRANSFORM_TOOL_NAME = IMAGE_TOOLS.chroma_key.name

export interface ImageTransformToolDetails {
  artifactIds: string[]
  code?: string
}

export function classifyImageTransformTool(
  event: ToolCallEvent,
): BuddyToolClassificationResult | null {
  if (event.toolName !== IMAGE_TRANSFORM_TOOL_NAME)
    return null
  return Check(imageTransformParameters, event.input)
    ? {
        access: 'write',
        paths: [{ mode: 'create', path: event.input.outputPath }],
      }
    : createToolClassificationFailure('VALIDATION_FAILED')
}

export function createImageTransformRunOutput(
  input: Pick<CreateBuddyToolPresentationInput, 'isError' | 'result' | 'toolName'> & {
    toolCallId: string
  },
): BuddyRunOutputPayload | null {
  if (input.isError || input.toolName !== IMAGE_TRANSFORM_TOOL_NAME)
    return null
  const artifactIds = readImageTransformToolDetails(input.result)?.artifactIds ?? []
  return artifactIds.length > 0
    ? {
        artifactIds,
        sourceToolCallId: input.toolCallId,
        sourceToolName: input.toolName,
      }
    : null
}

export function createImageTransformToolPresentation(
  input: CreateBuddyToolPresentationInput,
): Extract<BuddyToolPresentation, { card: 'image' }> | null {
  if (input.toolName !== IMAGE_TRANSFORM_TOOL_NAME)
    return null
  const arguments_ = readRecord(input.arguments)
  const details = readImageTransformToolDetails(input.result)
  const sourceArtifactId = typeof arguments_?.sourceArtifactId === 'string'
    ? arguments_.sourceArtifactId
    : null
  return {
    artifactIds: details?.artifactIds ?? [],
    card: 'image',
    description: 'Remove chroma background',
    generatedCount: details?.artifactIds.length ?? null,
    prompt: null,
    reference: sourceArtifactId
      ? { mode: 'resources', resourceIds: [sourceArtifactId] }
      : null,
    status: input.result === undefined
      ? 'running'
      : input.isError || Boolean(details?.code)
        ? 'failed'
        : 'completed',
  }
}

export function readImageTransformToolDetails(value: unknown): ImageTransformToolDetails | null {
  const details = readRecord(readRecord(value)?.details)
  if (!details)
    return null
  const artifactIds = Array.isArray(details.artifactIds)
    ? [...new Set(details.artifactIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256,
      ))].slice(0, 16)
    : []
  return {
    artifactIds,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
  }
}
