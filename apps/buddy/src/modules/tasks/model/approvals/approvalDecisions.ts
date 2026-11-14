import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { ApprovalReuseScope } from '@buddy-shared/permissions/approvalReviewPayload'
import type { ChatApprovalDecision } from '../runs/typing'
import { approvalReviewPayloadSchema } from '@buddy-shared/permissions/approvalReviewPayload'

export function projectApprovalDecisions(approval: LocalApproval, now: number) {
  const parsed = approvalReviewPayloadSchema.safeParse(approval.payload)
  const review = parsed.success ? parsed.data : null
  const authority = approval.review
  const expired = Boolean(authority && now >= Date.parse(authority.expiresAt))
  const canDecide = approval.status === 'pending' && authority !== null && !expired
  const canApprove = canDecide && !!review && (!authority || (authority.complete && authority.allowedDecisions.includes('approved')))
  const canDeny = canDecide && (!authority || authority.allowedDecisions.includes('denied'))
  const canPersist = (!authority || authority.allowedDecisions.includes('approved_persistently')) && (review?.card === 'network-permission'
    ? review.canPersist
    : review?.card === 'paths'
      ? Boolean(review.canPersist && review.grant)
      : review?.card === 'sandbox-directory' && Boolean(review.persistentDirectory))
  const offered: readonly ApprovalReuseScope[] = review?.reuseScopes ?? (review?.allowForTurn ? ['turn'] : [])
  const reuseScopes = authority ? offered.filter(scope => authority.allowedDecisions.includes(`approved_for_${scope}`)) : offered
  const decisions: ChatApprovalDecision[] = [
    ...canDeny ? ['deny' as const] : [],
    ...canApprove ? ['once' as const, ...reuseScopes, ...canPersist ? ['persistent' as const] : []] : [],
  ]
  return { review, expired, canApprove, canDeny, canPersist, reuseScopes, decisions }
}
