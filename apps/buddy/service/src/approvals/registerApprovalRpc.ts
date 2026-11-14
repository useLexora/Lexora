import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type {
  ApprovalRecord,
  ApprovalRepository,
} from '../storage/approvalRepository'
import type { ApprovalService } from './ApprovalService'
import { approvalsRequestSchemas, approvalsRpc } from '../../../shared/permissions/approvalApi'
import { APPROVAL_REVIEW_KINDS } from '../../../shared/permissions/approvalReviewPayload'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export interface RegisterApprovalRpcOptions {
  commandService?: Pick<ApprovalService, 'resolveCommand' | 'getReview'>
  repository: Pick<ApprovalRepository, 'list'>
  rpc: RuntimeRequestRegistrar
  service: Pick<ApprovalService, 'resolve'>
}

export function registerApprovalRpc(options: RegisterApprovalRpcOptions): () => void {
  const disposers: Array<() => void> = []

  disposers.push(registerRuntimeRequest(options.rpc, approvalsRpc.list, (input) => {
    return options.repository.list(input).map(approval => toPublicApproval(approval, Boolean(options.commandService)))
  }))
  disposers.push(registerRuntimeRequest(options.rpc, approvalsRpc.approve, async (input) => {
    return toPublicApproval(await options.service.resolve({
      decision: input.scope === 'once' ? 'approved' : input.scope === 'persistent' ? 'approved_persistently' : `approved_for_${input.scope}`,
      id: input.approvalId,
    }))
  }))
  disposers.push(registerRuntimeRequest(options.rpc, approvalsRpc.deny, async (input) => {
    return toPublicApproval(await options.service.resolve({
      decision: 'denied',
      id: input.approvalId,
    }))
  }))

  if (options.commandService) {
    const service = options.commandService
    disposers.push(options.rpc.onRequest('approvals.resolve', input => service.resolveCommand(input)))
    disposers.push(options.rpc.onRequest('approvals.getReview', input => service.getReview(approvalsRequestSchemas.approvalId.parse(input).approvalId)))
  }
  return () => disposers.splice(0).forEach(dispose => dispose())
}

function toPublicApproval(approval: ApprovalRecord, conditional = false) {
  return {
    id: approval.id,
    runId: approval.runId,
    toolCallId: approval.toolCallId,
    status: approval.status,
    summary: approval.summary,
    payload: approval.payload,
    ...(conditional || approval.review !== undefined ? { review: approval.review ?? null } : {}),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    kind: isApprovalKind(approval.kind) ? approval.kind : 'system',
  }
}

function isApprovalKind(value: string): value is typeof APPROVAL_REVIEW_KINDS[number] {
  return (APPROVAL_REVIEW_KINDS as readonly string[]).includes(value)
}
