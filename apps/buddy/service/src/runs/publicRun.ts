import type { RunRecord } from '../storage/runRecord'

export function toPublicRun(run: RunRecord, reasoningLevel: string | null) {
  return {
    buddyId: run.buddyId,
    approvalPolicy: run.approvalPolicy,
    branchId: run.branchId,
    completedAt: run.completedAt,
    conversationId: run.conversationId,
    errorCode: run.errorCode,
    executionProfile: run.executionProfile,
    id: run.id,
    modelId: run.model,
    providerId: run.provider,
    purpose: run.purpose,
    reasoningLevel,
    startedAt: run.startedAt,
    status: run.status,
    triggeringMessageId: run.triggeringMessageId,
  }
}
