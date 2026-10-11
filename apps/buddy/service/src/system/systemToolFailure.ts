import type { SystemCapabilityErrorCode } from './systemCapability'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'

export const SYSTEM_TOOLS = toPiToolGroup({ name: 'lexora_system', description: 'Request authorized changes to host processes and services.', tools: [{ name: 'action' }] })

export const SYSTEM_ACTION_TOOL_NAME = SYSTEM_TOOLS.action.name

export type SystemToolFailureCode
  = SystemCapabilityErrorCode
    | 'SYSTEM_CAPABILITY_FAILED'

export interface SystemToolFailureRecovery {
  instruction: string
  toolName: typeof SYSTEM_ACTION_TOOL_NAME
}

export interface SystemToolFailure {
  error: {
    code: SystemToolFailureCode
    recoverable: boolean
    recovery?: SystemToolFailureRecovery
  }
}

const SYSTEM_TOOL_FAILURE_CODES = new Set<SystemToolFailureCode>([
  'SYSTEM_ACCESS_DENIED',
  'SYSTEM_ACTION_CHANGED',
  'SYSTEM_ACTION_EXPIRED',
  'SYSTEM_ACTION_INVALID',
  'SYSTEM_ACTION_NOT_ALLOWED',
  'SYSTEM_ACTION_NOT_PREPARED',
  'SYSTEM_CAPABILITY_FAILED',
  'SYSTEM_TARGET_AMBIGUOUS',
  'SYSTEM_TARGET_CHANGED',
  'SYSTEM_TARGET_NOT_FOUND',
])

const RETRY_ACTION_CODES = new Set<SystemToolFailureCode>([
  'SYSTEM_ACTION_EXPIRED',
  'SYSTEM_ACTION_NOT_PREPARED',
  'SYSTEM_TARGET_CHANGED',
])

const REDISCOVER_TARGET_CODES = new Set<SystemToolFailureCode>([
  'SYSTEM_TARGET_AMBIGUOUS',
  'SYSTEM_TARGET_NOT_FOUND',
])

export function createSystemToolFailure(code: SystemToolFailureCode): SystemToolFailure {
  const retryAction = RETRY_ACTION_CODES.has(code)
  const rediscoverTarget = REDISCOVER_TARGET_CODES.has(code)
  const recoverable = retryAction || rediscoverTarget
  return {
    error: {
      code,
      recoverable,
      ...(recoverable
        ? {
            recovery: {
              instruction: retryAction
                ? 'Retry lexora_system_action so Lexora Buddy can resolve and approve the current target again.'
                : 'Use the active shell to identify one exact process or service, then retry lexora_system_action with a more precise selector.',
              toolName: SYSTEM_ACTION_TOOL_NAME,
            },
          }
        : {}),
    },
  }
}

export function serializeSystemToolFailure(code: SystemToolFailureCode): string {
  return JSON.stringify(createSystemToolFailure(code))
}

export function parseSystemToolFailure(value: string | null): SystemToolFailure | null {
  if (!value)
    return null
  try {
    const payload = readRecord(JSON.parse(value))
    const error = readRecord(payload?.error)
    const code = error?.code
    return typeof code === 'string' && SYSTEM_TOOL_FAILURE_CODES.has(code as SystemToolFailureCode)
      ? createSystemToolFailure(code as SystemToolFailureCode)
      : null
  }
  catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
