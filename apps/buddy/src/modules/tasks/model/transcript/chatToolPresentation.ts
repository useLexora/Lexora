import type { ApprovalReviewPayload } from '@buddy-shared/permissions/approvalReviewPayload'
import type { BuddyToolPresentation, BuddyToolPresentationDelta } from '@buddy-shared/runs/runEventPresentation'
import { buddyToolPresentationDeltaSchema, buddyToolPresentationSchema } from '@buddy-shared/runs/runEventPresentation'

export function readToolPresentationUpdate(
  payload: Record<string, unknown>,
  current: BuddyToolPresentation | undefined,
): BuddyToolPresentation | null {
  const presentation = buddyToolPresentationSchema.safeParse(payload.presentation)
  if (presentation.success)
    return presentation.data
  const delta = buddyToolPresentationDeltaSchema.safeParse(payload.presentationDelta)
  if (!delta.success || current?.card !== 'terminal')
    return null
  return appendTerminalPresentationDelta(current, delta.data)
}

function appendTerminalPresentationDelta(
  current: Extract<BuddyToolPresentation, { card: 'terminal' }>,
  delta: BuddyToolPresentationDelta,
): BuddyToolPresentation | null {
  const output = current.output ?? ''
  if (output.length !== delta.outputStart)
    return null
  const nextOutput = output + delta.outputDelta
  return {
    ...current,
    output: nextOutput || null,
    truncated: delta.truncated,
  }
}

const GENERIC_TOOL_DESCRIPTIONS = new Set([
  'run a shell command in the authorized directory',
  'execute a shell command',
  'execute bash commands',
])

export function specificToolDescription(value: string | null): string | null {
  if (!value)
    return null
  return GENERIC_TOOL_DESCRIPTIONS.has(normalizeProcessNarration(value).toLowerCase())
    ? null
    : value
}

export function approvalPresentation(review: ApprovalReviewPayload): BuddyToolPresentation {
  if (review.card === 'shell' || review.card === 'sandbox-network' || (review.card === 'network-permission' && review.command !== undefined)) {
    return {
      card: 'terminal',
      command: review.command!,
      cwd: null,
      description: null,
      exitCode: null,
      output: null,
      signal: null,
      truncated: false,
    }
  }
  if (review.card === 'system-action') {
    return {
      action: review.action,
      card: 'system',
      description: null,
      output: null,
      status: 'awaiting-approval',
      target: review.target.displayName,
      truncated: false,
      verified: null,
    }
  }
  if (review.card === 'automation') {
    return {
      automationId: null,
      card: 'automation',
      itemCount: null,
      name: review.name,
      nextRunAt: null,
      occurrenceId: null,
      operation: review.operation,
      status: 'awaiting-approval',
    }
  }
  if (review.card === 'browser-action') {
    return {
      argumentNames: [],
      card: 'generic',
      description: null,
      output: null,
      truncated: false,
    }
  }
  if (review.card === 'web' || review.card === 'network-target' || review.card === 'network-permission') {
    return {
      card: 'web',
      description: null,
      operation: review.card === 'web' ? review.operation : 'fetch',
      output: null,
      provider: review.card === 'web' ? review.provider : null,
      target: review.card === 'network-permission' ? review.host : review.target,
      truncated: false,
    }
  }
  const argumentNames = review.card === 'arguments'
    ? review.argumentNames
    : review.card === 'sandbox-directory'
      ? ['path', 'access', 'reason']
      : review.targets.length > 0 ? ['targets'] : []
  if (review.toolName.startsWith('mcp__')) {
    const [, connector = 'connector', ...toolParts] = review.toolName.split('__')
    return {
      argumentNames,
      card: 'connector',
      connector,
      description: null,
      output: null,
      tool: toolParts.join('__') || review.toolName,
      truncated: false,
    }
  }
  return {
    argumentNames,
    card: 'generic',
    description: null,
    output: null,
    truncated: false,
  }
}

export function normalizeProcessNarration(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
