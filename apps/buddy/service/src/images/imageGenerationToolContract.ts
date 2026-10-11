import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { BuddyRunOutputPayload } from '../../../shared/runs/runOutput'
import type { BuddyToolClassification } from '../approvals/toolClassification'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import type { ImageGenerationErrorDiagnostic } from './ImageGenerationGateway'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../../../shared/conversation/attachmentPolicy'
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
  responseId: string | null
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
  return {
    artifactIds: details?.artifactIds ?? [],
    card: 'image',
    description: readOptionalString(arguments_, 'description'),
    generatedCount: details?.artifactIds.length ?? null,
    prompt: readOptionalString(arguments_, 'prompt'),
    reference: readImageReference(arguments_),
    status: input.result === undefined
      ? 'running'
      : input.isError
        ? 'failed'
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
  const diagnostic = readDiagnostic(details.diagnostic)
  return {
    artifactIds,
    ...(typeof details.code === 'string' && details.code ? { code: details.code } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    responseId: typeof details.responseId === 'string' && details.responseId
      ? details.responseId
      : null,
  }
}

function readDiagnostic(value: unknown): ImageGenerationErrorDiagnostic | null {
  const diagnostic = readRecord(value)
  if (!diagnostic)
    return null
  const providerCode = readBoundedString(diagnostic.providerCode)
  const providerParameter = readBoundedString(diagnostic.providerParameter)
  const requestId = readBoundedString(diagnostic.requestId)
  if (!providerCode && !providerParameter && !requestId)
    return null
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(providerParameter ? { providerParameter } : {}),
    ...(requestId ? { requestId } : {}),
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

function readBoundedString(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const result = value.trim()
  return result && result.length <= 256 && isDiagnosticToken(result)
    ? result
    : null
}

function isDiagnosticToken(value: string): boolean {
  const allowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-[]:/'
  return [...value].every(character => allowedCharacters.includes(character))
}
