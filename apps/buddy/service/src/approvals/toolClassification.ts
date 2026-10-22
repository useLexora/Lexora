import type {
  ApprovalReviewKind,
  AutomationApprovalReviewInput,
  BrowserApprovalReviewInput,
  PathApprovalReviewInput,
  SystemActionApprovalReviewInput,
} from '../../../shared/permissions/approvalReviewPayload'
import type { AccessKind, PermissionPath } from '../permissions/permissionContract'
import type { ApprovalAuthorizationOverride } from './approvalAuthorization'

export interface BuddyToolClassification {
  networkManaged?: boolean
  access?: AccessKind
  approval?: {
    automation?: AutomationApprovalReviewInput
    browser?: BrowserApprovalReviewInput
    kind?: ApprovalReviewKind
    paths?: PathApprovalReviewInput
    reuse?: ApprovalAuthorizationOverride
    summary: string
    systemAction?: SystemActionApprovalReviewInput
  }
  forceAsk?: boolean
  requireApproval?: boolean
  shellBoundary?: 'sandbox'
  shellReadOnly?: boolean
  shellDialect?: import('../../../shared/shell/shellProgram').ShellDialect
  paths?: readonly PermissionPath[]
  validateBeforeExecution?: () => Promise<BuddyToolClassificationFailure | null>
}

export interface BuddyToolClassificationFailure {
  blocked: true
  reason: string
}

export type BuddyToolClassificationResult
  = BuddyToolClassification | BuddyToolClassificationFailure

export function createToolClassificationFailure(
  reason: string,
): BuddyToolClassificationFailure {
  return { blocked: true, reason }
}

export function isToolClassificationFailure(
  result: BuddyToolClassificationResult,
): result is BuddyToolClassificationFailure {
  return 'blocked' in result
}
