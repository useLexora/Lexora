import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationErrorDiagnostic, ImageGenerationOutcome, ImageRequestRef } from '../../../shared/images/imageGeneration'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { BuddyRunOutputPayload } from '../../../shared/runs/runOutput'
import type { BuddyToolClassification } from '../approvals/toolClassification'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../../../shared/conversation/attachmentPolicy'
import { imageGenerationFailureSchema, imageRequestRefSchema, readImageDiagnostic } from '../../../shared/images/imageGeneration'
import { imageSourceSchema } from '../../../shared/images/imagePreferences'
import {
  readOptionalString,
  readRecord,
} from '../events/toolPresentationSupport'
import { IMAGE_TOOLS } from './imageToolGroup'

export const IMAGE_GENERATION_TOOL_NAME = IMAGE_TOOLS.generate.name

export interface ImageGenerationToolDetails {
  artifactIds: string[]
  code?: string
  diagnostic?: ImageGenerationErrorDiagnostic
  outputs?: Array<{ artifactId: string, path: string, mimeType: string }>
  outcome?: ImageGenerationOutcome
  request?: ImageRequestRef
  responseId: string | null
  source?: Extract<BuddyToolPresentation, { card: 'image' }>['source']
}

export function classifyImageGenerationTool(
  event: Pick<ToolCallEvent, 'input' | 'toolName'>,
): BuddyToolClassification | null {
  if (event.toolName !== IMAGE_GENERATION_TOOL_NAME)
    return null
  const outputPath = readRecord(event.input)?.outputPath
  return {
    access: 'write',
    paths: typeof outputPath === 'string'
      ? [{ mode: 'create', path: outputPath }]
      : [],
  }
}

export function createImageGenerationRunOutput(
  input: Pick<
    CreateBuddyToolPresentationInput,
    'isError' | 'result' | 'toolName'
  > & { toolCallId: string },
): BuddyRunOutputPayload | null {
  if (input.isError || input.toolName !== IMAGE_GENERATION_TOOL_NAME)
    return null
  const artifactIds = readImageGenerationToolDetails(input.result)?.artifactIds ?? []
  return artifactIds.length > 0
    ? {
        artifactIds,
        sourceToolCallId: input.toolCallId,
        sourceToolName: input.toolName,
      }
    : null
}

export function createImageGenerationToolPresentation(
  input: CreateBuddyToolPresentationInput,
): Extract<BuddyToolPresentation, { card: 'image' }> | null {
  if (input.toolName !== IMAGE_GENERATION_TOOL_NAME)
    return null
  const arguments_ = readRecord(input.arguments)
  const details = readImageGenerationToolDetails(input.result)
  const failure = imageGenerationFailureSchema.safeParse({ code: details?.code, outcome: details?.outcome, diagnostic: details?.diagnostic ?? null })
  return {
    artifactIds: details?.artifactIds ?? [],
    ...(failure.success ? { failure: failure.data } : {}),
    ...(details?.request ? { request: details.request } : {}),
    card: 'image',
    description: readOptionalString(arguments_, 'description'),
    generatedCount: details?.artifactIds.length ?? null,
    ...(details?.source ? { source: details.source } : {}),
    prompt: readOptionalString(arguments_, 'prompt'),
    reference: readImageReference(arguments_),
    status: input.result === undefined
      ? 'running'
      : input.isError
        ? details?.code === 'IMAGE_GENERATION_BLOCKED' ? 'blocked' : details?.outcome ?? 'failed'
        : 'completed',
  }
}

export function readImageGenerationToolDetails(value: unknown): ImageGenerationToolDetails | null {
  const result = readRecord(value)
  const details = readRecord(result?.details)
  if (!details)
    return null
  const artifactIds = Array.isArray(details.artifactIds)
    ? [...new Set(details.artifactIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256,
      ))].slice(0, BUDDY_ATTACHMENT_COUNT_LIMIT)
    : []
  const diagnostic = readImageDiagnostic(details.diagnostic)
  const request = imageRequestRefSchema.safeParse(details.request)
  const source = imageSourceSchema.safeParse(details.source)
  return {
    artifactIds,
    ...(['failed', 'unknown', 'partial'].includes(details.outcome as string) ? { outcome: details.outcome as ImageGenerationOutcome } : {}),
    ...(request.success ? { request: request.data } : {}),
    ...(typeof details.code === 'string' && details.code ? { code: details.code } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(source.success ? { source: source.data } : {}),
    responseId: typeof details.responseId === 'string' && details.responseId
      ? details.responseId
      : null,
  }
}

function readImageReference(
  arguments_: Record<string, unknown> | null,
): Extract<BuddyToolPresentation, { card: 'image' }>['reference'] {
  const reference = readRecord(arguments_?.reference)
  if (reference?.mode === 'latest') {
    return {
      mode: 'latest',
    }
  }
  if (reference?.mode !== 'resources' || !Array.isArray(reference.resourceIds))
    return null
  const resourceIds = [...new Set(reference.resourceIds.filter(
    (value): value is string => typeof value === 'string' && Boolean(value),
  ))].slice(0, 4)
  return resourceIds.length > 0
    ? { mode: 'resources', resourceIds }
    : null
}
