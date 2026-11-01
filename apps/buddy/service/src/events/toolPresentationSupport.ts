import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'

import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'

export const MAX_TOOL_PRESENTATION_OUTPUT_LENGTH = 64 * 1024

export interface CreateBuddyToolPresentationInput {
  arguments: unknown
  canonicalRoot?: string
  isError?: boolean
  result?: unknown
  toolName: string
  previous?: BuddyToolPresentation
}

export function argumentNames(value: Record<string, unknown> | null): string[] {
  return value ? Object.keys(value).sort().slice(0, 32) : []
}

export function boundedToolPreview(value: string | null): Pick<
  Extract<BuddyToolPresentation, { output: unknown }>,
  'output' | 'truncated'
> {
  if (value === null)
    return { output: null, truncated: false }
  return {
    output: value.slice(0, MAX_TOOL_PRESENTATION_OUTPUT_LENGTH),
    truncated: value.length > MAX_TOOL_PRESENTATION_OUTPUT_LENGTH,
  }
}

export function readArrayLength(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const candidate = value?.[key]
  return Array.isArray(candidate) ? candidate.length : null
}

export function readBoolean(
  value: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const candidate = value?.[key]
  return typeof candidate === 'boolean' ? candidate : null
}

export function readOptionalString(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const candidate = value?.[key]
  return typeof candidate === 'string' && candidate.trim() ? candidate : null
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function readToolDetails(value: unknown): Record<string, unknown> | null {
  return readRecord(readRecord(value)?.details)
}

export function readToolOutput(value: unknown): string | null {
  const result = readRecord(value)
  if (!result || !Array.isArray(result.content))
    return null
  const text = result.content.flatMap((part) => {
    const content = readRecord(part)
    return content?.type === 'text' && typeof content.text === 'string'
      ? [content.text]
      : []
  }).join('\n')
  return text ? redactSensitiveText(text) : null
}
