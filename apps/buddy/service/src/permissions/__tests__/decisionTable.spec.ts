import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { AccessKind, PathZone } from '../permissionContract'
import { describe, expect, it } from 'vitest'

import { lookupPermissionOutcome } from '../decisionTable'

const zones: readonly PathZone[] = ['workspace', 'granted', 'outside', 'sensitive']

const expected: Record<
  BuddyExecutionProfile,
  Record<AccessKind, readonly string[]>
> = {
  read_only: {
    delete: ['deny_profile', 'deny_profile', 'deny_profile', 'deny_sensitive'],
    execute: ['delegate_allowlist', 'delegate_allowlist', 'delegate_allowlist', 'deny_sensitive'],
    interaction: ['ask', 'ask', 'ask', 'ask'],
    network: ['ask', 'ask', 'ask', 'ask'],
    read: ['allow', 'allow', 'allow', 'ask'],
    render: ['allow', 'allow', 'ask_grant', 'deny_sensitive'],
    visual: ['allow', 'allow', 'allow', 'allow'],
    write: ['deny_profile', 'deny_profile', 'deny_profile', 'deny_sensitive'],
  },
  workspace_write: {
    delete: ['allow', 'allow', 'ask_grant', 'deny_sensitive'],
    execute: ['delegate', 'delegate', 'delegate', 'deny_sensitive'],
    interaction: ['allow', 'allow', 'allow', 'allow'],
    network: ['ask', 'ask', 'ask', 'ask'],
    read: ['allow', 'allow', 'allow', 'ask'],
    render: ['allow', 'allow', 'ask_grant', 'deny_sensitive'],
    visual: ['allow', 'allow', 'allow', 'allow'],
    write: ['allow', 'allow', 'ask_grant', 'deny_sensitive'],
  },
  full_access: {
    delete: ['allow', 'allow', 'allow', 'allow'],
    execute: ['allow', 'allow', 'allow', 'allow'],
    interaction: ['allow', 'allow', 'allow', 'allow'],
    network: ['allow', 'allow', 'allow', 'allow'],
    read: ['allow', 'allow', 'allow', 'allow'],
    render: ['allow', 'allow', 'allow', 'allow'],
    visual: ['allow', 'allow', 'allow', 'allow'],
    write: ['allow', 'allow', 'allow', 'allow'],
  },
}

describe('permission decision table', () => {
  it('defines every profile, access kind, and zone', () => {
    for (const [profile, rows] of Object.entries(expected) as Array<[
      BuddyExecutionProfile,
      Record<AccessKind, readonly string[]>,
    ]>) {
      for (const [access, outcomes] of Object.entries(rows) as Array<[
        AccessKind,
        readonly string[],
      ]>) {
        expect(zones.map(zone => lookupPermissionOutcome({ access, profile, zone })))
          .toEqual(outcomes)
      }
    }
  })
})
