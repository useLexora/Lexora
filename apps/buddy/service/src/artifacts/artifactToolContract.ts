import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyRunOutputPayload } from '../../../shared/runs/runOutput'
import type { BuddyToolClassificationResult } from '../approvals/toolClassification'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'
import { createToolClassificationFailure } from '../approvals/toolClassification'
import { readRecord } from '../events/toolPresentationSupport'

export const OUTPUT_TOOLS = toPiToolGroup({ name: 'lexora_output', description: 'Present completed task files and artifacts.', tools: [{ name: 'present' }] })

export const OUTPUT_PRESENT_TOOL_NAME = OUTPUT_TOOLS.present.name

export const outputPresentParameters = Type.Object({
  paths: Type.Array(Type.String({
    description: 'Existing file or directory path, relative to the current workspace or absolute.',
    maxLength: 4096,
    minLength: 1,
    pattern: '\\S',
  }), {
    maxItems: 16,
    minItems: 1,
    uniqueItems: true,
  }),
}, { additionalProperties: false })

export interface OutputPresentToolDetails {
  artifactIds: string[]
  code?: string
}

export function classifyOutputPresentTool(
  event: Pick<ToolCallEvent, 'input' | 'toolName'>,
): BuddyToolClassificationResult | null {
  if (event.toolName !== OUTPUT_PRESENT_TOOL_NAME)
    return null
  if (!Check(outputPresentParameters, event.input))
    return createToolClassificationFailure('VALIDATION_FAILED')
  return {
    access: 'read',
    paths: event.input.paths.map(path => ({ mode: 'existing' as const, path })),
  }
}

export function createOutputPresentRunOutput(
  input: Pick<CreateBuddyToolPresentationInput, 'isError' | 'result' | 'toolName'> & {
    toolCallId: string
  },
): BuddyRunOutputPayload | null {
  if (input.isError || input.toolName !== OUTPUT_PRESENT_TOOL_NAME)
    return null
  const artifactIds = readOutputPresentToolDetails(input.result)?.artifactIds ?? []
  return artifactIds.length > 0
    ? {
        artifactIds,
        sourceToolCallId: input.toolCallId,
        sourceToolName: input.toolName,
      }
    : null
}

export function readOutputPresentToolDetails(value: unknown): OutputPresentToolDetails | null {
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
