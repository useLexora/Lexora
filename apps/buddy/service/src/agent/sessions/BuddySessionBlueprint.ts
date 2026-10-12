import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { SpaceMemoryScope } from '../../storage/spaceRepository'
import type { BuddySessionResources } from '../resources/BuddySessionResources'
import { buddyExecutionFingerprint } from '../../buddies/BuddyExecutionDefinition'

export interface BuddySessionIdentity {
  threadId?: string
  actorKind?: 'actor' | 'npc'
  actorId?: string
  actorFingerprint?: string
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  canonicalRoot: string
  conversationId: string
  executionProfile: BuddyExecutionProfile
  grantRevision: string
  resourceRevision: string
  skillRevision?: string
  scratchRoot: string
  sessionMode: BuddySessionMode
  spaceId: string | null
}

export interface BuddySessionSpaceSnapshot {
  additionalDirectoryBindings: readonly { id: string, revision: number }[]
  id: string
  memoryScope: SpaceMemoryScope
  primaryDirectoryBinding: { id: string, revision: number } | null
}

export interface BuddySessionBlueprint {
  threadId?: string
  actor?: BuddyExecutionDefinition
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  canonicalRoot: string
  conversationId: string
  executionProfile: BuddyExecutionProfile
  grantRevision: string
  grants: readonly DirectoryGrant[]
  resources: BuddySessionResources
  scratchRoot: string
  sessionMode: BuddySessionMode
  space: BuddySessionSpaceSnapshot | null
}

export function toBuddySessionIdentity(
  blueprint: BuddySessionBlueprint,
): BuddySessionIdentity {
  return {
    threadId: blueprint.threadId,
    actorKind: blueprint.actor?.kind,
    ...(blueprint.actor ? { actorId: blueprint.actor.id, actorFingerprint: buddyExecutionFingerprint(blueprint.actor) } : {}),
    approvalPolicy: blueprint.approvalPolicy,
    branchId: blueprint.branchId,
    canonicalRoot: blueprint.canonicalRoot,
    conversationId: blueprint.conversationId,
    executionProfile: blueprint.executionProfile,
    grantRevision: blueprint.grantRevision,
    resourceRevision: blueprint.resources.revision,
    skillRevision: blueprint.resources.skillRevision,
    scratchRoot: blueprint.scratchRoot,
    sessionMode: blueprint.sessionMode,
    spaceId: blueprint.space?.id ?? null,
  }
}
