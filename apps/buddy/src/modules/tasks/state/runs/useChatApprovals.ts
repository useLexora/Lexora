import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { Ref } from 'vue'
import type { ChatApprovalDecision } from '../../model/runs/typing'
import { computed, readonly, shallowRef } from 'vue'
import { projectApprovalDecisions } from '../../model/approvals/approvalDecisions'

interface UseChatApprovalsOptions {
  api: LocalChatApi
  approvals: Ref<ReadonlyArray<LocalApproval>>
  onError: (error: unknown) => void
  refresh: () => Promise<void>
}

export function useChatApprovals(options: UseChatApprovalsOptions) {
  const resolvingApprovalActions = shallowRef<ReadonlyMap<string, ChatApprovalDecision>>(new Map())
  const resolvingApprovalIds = computed<ReadonlySet<string>>(
    () => new Set(resolvingApprovalActions.value.keys()),
  )

  async function resolveApproval(
    approvalId: string,
    decision: ChatApprovalDecision,
  ) {
    if (resolvingApprovalActions.value.has(approvalId))
      return
    const approval = options.approvals.value.find(item => item.id === approvalId)
    if (!approval || approval.status !== 'pending' || approval.review === null)
      return

    if (!projectApprovalDecisions(approval, Date.now()).decisions.includes(decision)) {
      await options.refresh()
      return
    }
    const conditions = approval.review ? { runId: approval.runId, reviewVersion: approval.review.reviewVersion } : undefined
    resolvingApprovalActions.value = new Map([
      ...resolvingApprovalActions.value,
      [approvalId, decision],
    ])
    try {
      if (decision === 'deny')
        await (conditions ? options.api.approvals.deny(approvalId, conditions) : options.api.approvals.deny(approvalId))
      else
        await (conditions ? options.api.approvals.approve(approvalId, decision, conditions) : options.api.approvals.approve(approvalId, decision))
      await options.refresh()
    }
    catch (error) {
      options.onError(error)
    }
    finally {
      const next = new Map(resolvingApprovalActions.value)
      next.delete(approvalId)
      resolvingApprovalActions.value = next
    }
  }

  return {
    approvalViews: options.approvals,
    resolveApproval,
    resolvingApprovalActions: readonly(resolvingApprovalActions),
    resolvingApprovalIds,
  }
}
