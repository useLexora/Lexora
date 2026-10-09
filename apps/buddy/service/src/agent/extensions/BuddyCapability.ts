import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { BuddyToolClassificationResult } from '../../approvals/toolClassification'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import type { BuddyToolDisclosurePolicy } from './discovery/toolDiscoveryContract'

export interface BuddyCapabilityResourceRevision {
  readonly source: 'connector' | 'plugin'
  readonly id: string
  readonly revision: string
}

export interface BuddyCapability {
  dispose?: () => void | Promise<void>
  resourceRevisions?: readonly BuddyCapabilityResourceRevision[]
  extension: BuddyInProcessExtension
  classify: (event: ToolCallEvent, signal: AbortSignal) =>
    BuddyToolClassificationResult | null | Promise<BuddyToolClassificationResult | null>
  workspaceMutationTools?: readonly string[]
  disclosure?: readonly BuddyToolDisclosurePolicy[]
}

export interface BuddyCapabilityContext {
  conversationId: string
  executionProfile: BuddyExecutionProfile
  cwd: string
  getRunId: () => string | undefined
  isCodemodeEnabled?: () => boolean
  grants: readonly DirectoryGrant[]
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  sessionMode: BuddySessionMode
  signal: AbortSignal
}

export type BuddyCapabilityFactory = (
  context: BuddyCapabilityContext,
) => Promise<readonly BuddyCapability[]>
