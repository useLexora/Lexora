import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type {
  ApprovalRecord,
  ApprovalRepository,
} from '../storage/approvalRepository'
import type { ApprovalService } from './ApprovalService'
import { approvalsRpc } from '../../../shared/permissions/approvalApi'
import { APPROVAL_REVIEW_KINDS } from '../../../shared/permissions/approvalReviewPayload'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export interface RegisterApprovalRpcOptions {
  repository: Pick<ApprovalRepository, 'list'>
  rpc: RuntimeRequestRegistrar
  service: Pick<ApprovalService, 'resolve'>
}

export function registerApprovalRpc(options: RegisterApprovalRpcOptions): () => void {
  const disposers: Array<() => void> = []

  disposers.push(registerRuntimeRequest(options.rpc, approvalsRpc.list, (input) => {
    return options.repository.list(input).map(toPublicApproval)
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

  return () => disposers.splice(0).forEach(dispose => dispose())
}

function toPublicApproval(approval: ApprovalRecord) {
  return {
    ...approval,
    kind: isApprovalKind(approval.kind) ? approval.kind : 'system',
  }
}

function isApprovalKind(value: string): value is typeof APPROVAL_REVIEW_KINDS[number] {
  return (APPROVAL_REVIEW_KINDS as readonly string[]).includes(value)
}
