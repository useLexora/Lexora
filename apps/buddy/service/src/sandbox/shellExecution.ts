import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import process from 'node:process'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { getPiShellToolName } from '../agent/extensions/piBuiltinTools'

export const WINDOWS_SANDBOX_FILESYSTEM_LIMITS = 'Windows native filesystem isolation has limits: host files writable by Everyone may remain writable outside authorized directories, including in read-only mode; explicit public read permissions on sensitive files may bypass an inherited directory deny. Files created or given custom permissions by earlier commands may remain writable after authorization is revoked. These OS permissions do not authorize access: follow the task permissions and never exploit these limits.'

export function resolveShellExecution(profile: BuddyExecutionProfile, platform: NodeJS.Platform = process.platform) {
  const dialect = getPiShellToolName(platform)
  const { sandbox: backend } = resolveBuddyPlatform(platform)
  return {
    profile,
    dialect,
    boundary: profile !== 'full_access' ? 'sandbox' as const : 'host' as const,
    backend,
    readOnly: profile === 'read_only',
  }
}

export type ShellExecution = ReturnType<typeof resolveShellExecution>

export function resolveShellCallExecution(execution: ShellExecution, input: Record<string, unknown>, host = false): ShellExecution {
  if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean')
    throw new Error('VALIDATION_FAILED')
  const boundary = host ? 'host' : execution.boundary
  if (input.readOnly === true && boundary === 'host')
    throw new Error('SHELL_READ_ONLY_REQUIRES_SANDBOX')
  return { ...execution, boundary, readOnly: boundary === 'sandbox' && (execution.readOnly || input.readOnly === true) }
}
