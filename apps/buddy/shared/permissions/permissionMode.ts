import type { BuddyApprovalPolicy } from './approvalPolicy'
import type { BuddyExecutionProfile } from './executionProfile'

export const BUDDY_PERMISSION_MODES = [
  'read_only',
  'manual_approval',
  'policy_approval',
  'full_access',
] as const

export type BuddyPermissionMode = typeof BUDDY_PERMISSION_MODES[number]

export const BUDDY_DEFAULT_PERMISSION_MODE: BuddyPermissionMode = 'policy_approval'

export interface BuddyPermissionSettings {
  approvalPolicy: BuddyApprovalPolicy
  executionProfile: BuddyExecutionProfile
}

const SETTINGS_BY_MODE: Record<BuddyPermissionMode, BuddyPermissionSettings> = {
  read_only: { approvalPolicy: 'policy', executionProfile: 'read_only' },
  manual_approval: { approvalPolicy: 'manual', executionProfile: 'workspace_write' },
  policy_approval: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
  full_access: { approvalPolicy: 'policy', executionProfile: 'full_access' },
}

export function resolveBuddyPermissionSettings(
  mode: BuddyPermissionMode,
): BuddyPermissionSettings {
  return SETTINGS_BY_MODE[mode]
}

export function resolveBuddyPermissionMode(
  settings: BuddyPermissionSettings,
): BuddyPermissionMode {
  if (settings.executionProfile === 'read_only')
    return 'read_only'
  if (settings.executionProfile === 'full_access')
    return 'full_access'
  return settings.approvalPolicy === 'manual' ? 'manual_approval' : 'policy_approval'
}
