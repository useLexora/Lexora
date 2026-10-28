import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { AccessKind, PathZone } from './permissionContract'

export type PermissionOutcome
  = 'allow'
    | 'ask'
    | 'ask_grant'
    | 'delegate'
    | 'delegate_allowlist'
    | 'deny_profile'
    | 'deny_sensitive'

type ZoneOutcomes = Record<PathZone, PermissionOutcome>

function zones(
  workspace: PermissionOutcome,
  granted: PermissionOutcome,
  outside: PermissionOutcome,
  sensitive: PermissionOutcome,
): ZoneOutcomes {
  return { granted, outside, sensitive, workspace }
}

const READ_ANYWHERE = zones('allow', 'allow', 'allow', 'ask')
const UNIFORM_ASK = zones('ask', 'ask', 'ask', 'ask')
const UNIFORM_ALLOW = zones('allow', 'allow', 'allow', 'allow')

const TABLE: Record<
  BuddyExecutionProfile,
  Record<AccessKind, ZoneOutcomes>
> = {
  full_access: {
    delete: UNIFORM_ALLOW,
    execute: UNIFORM_ALLOW,
    interaction: UNIFORM_ALLOW,
    network: UNIFORM_ALLOW,
    read: UNIFORM_ALLOW,
    render: UNIFORM_ALLOW,
    visual: UNIFORM_ALLOW,
    write: UNIFORM_ALLOW,
  },
  read_only: {
    delete: zones('deny_profile', 'deny_profile', 'deny_profile', 'deny_sensitive'),
    execute: zones(
      'delegate_allowlist',
      'delegate_allowlist',
      'delegate_allowlist',
      'deny_sensitive',
    ),
    interaction: UNIFORM_ASK,
    network: UNIFORM_ASK,
    read: READ_ANYWHERE,
    render: zones('allow', 'allow', 'ask_grant', 'deny_sensitive'),
    visual: UNIFORM_ALLOW,
    write: zones('deny_profile', 'deny_profile', 'deny_profile', 'deny_sensitive'),
  },
  workspace_write: {
    delete: zones('allow', 'allow', 'ask_grant', 'deny_sensitive'),
    execute: zones('delegate', 'delegate', 'delegate', 'deny_sensitive'),
    interaction: UNIFORM_ALLOW,
    network: UNIFORM_ASK,
    read: READ_ANYWHERE,
    render: zones('allow', 'allow', 'ask_grant', 'deny_sensitive'),
    visual: UNIFORM_ALLOW,
    write: zones('allow', 'allow', 'ask_grant', 'deny_sensitive'),
  },
}

export function lookupPermissionOutcome(input: {
  access: AccessKind
  profile: BuddyExecutionProfile
  zone: PathZone
}): PermissionOutcome {
  return TABLE[input.profile][input.access][input.zone]
}

export function readPermissionTable(): typeof TABLE {
  return TABLE
}
