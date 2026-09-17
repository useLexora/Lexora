import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import process from 'node:process'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { getPiShellToolName } from '../agent/extensions/piBuiltinTools'

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
