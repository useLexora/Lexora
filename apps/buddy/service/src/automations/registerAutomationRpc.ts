import type {
  AutomationOccurrence,
  AutomationRunNowResult,
} from '../../../shared/automation'
import type { RuntimeRpcRegistrar } from '../rpc/runtimeRequest'
import type { ApprovalRepository } from '../storage/approvalRepository'
import type { AutomationOccurrenceRecord } from '../storage/automationOccurrenceRecord'
import type { RunRepository } from '../storage/runRepository'
import type { AutomationChangeCoordinator } from './AutomationChangeCoordinator'
import type { AutomationOccurrenceLifecycleService } from './AutomationOccurrenceLifecycleService'
import type { AutomationClock } from './AutomationScheduleEvaluator'
import type { AutomationService } from './AutomationService'

import { automationNotifications, automationsRpc } from '../../../shared/automation/automationApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'
import { previewAutomationSchedule } from './AutomationScheduleEvaluator'
import { AutomationServiceError } from './AutomationService'

export interface RegisterAutomationRpcOptions {
  approvals: Pick<ApprovalRepository, 'listPending'>
  changes: AutomationChangeCoordinator
  clock: AutomationClock
  lifecycle: Pick<AutomationOccurrenceLifecycleService, 'deleteOccurrence'>
  rpc: RuntimeRpcRegistrar
  runs: Pick<RunRepository, 'findById'>
  service: AutomationService
}

export function registerAutomationRpc(options: RegisterAutomationRpcOptions): () => void {
  const disposers: Array<() => void> = []

  disposers.push(options.rpc.onNotification((method, params) => {
    if (method !== automationNotifications.wake.method)
      return
    if (automationNotifications.wake.params.safeParse(params).success)
      options.changes.wakeScheduler()
  }))

  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.preview, (input) => {
    return previewAutomationSchedule(input, options.clock)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.list, (params) => {
    const page = options.service.list(params)
    return {
      ...page,
      items: page.items.map((automation) => {
        const occurrence = options.service.getActiveOccurrence(automation.id)
        return {
          ...automation,
          activeOccurrence: occurrence
            ? toAutomationOccurrenceView(options, occurrence)
            : null,
        }
      }),
    }
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.get, (input) => {
    const automation = options.service.get(input.automationId)
    if (!automation)
      throw new AutomationServiceError('AUTOMATION_NOT_FOUND')
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.create, (params) => {
    const automation = options.service.create(
      params,
    )
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.update, (params) => {
    const automation = options.service.update(
      params,
    )
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.pause, (params) => {
    const automation = options.service.pause(
      params,
    )
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.resume, (params) => {
    const automation = options.service.resume(
      params,
    )
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.delete, (params) => {
    const automation = options.service.delete(
      params,
    )
    return automation
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.runNow, (params) => {
    const result = options.service.runNow(
      params,
    )
    return toAutomationRunNowResult(result)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.listOccurrences, (params) => {
    const page = options.service.listHistory(
      params,
    )
    return {
      ...page,
      items: page.items.map(occurrence => toAutomationOccurrenceView(options, occurrence)),
    }
  }))
  disposers.push(registerRuntimeRequest(options.rpc, automationsRpc.deleteOccurrence, async (input) => {
    return (await options.lifecycle.deleteOccurrence(input.occurrenceId)).deleted
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
}

function toAutomationRunNowResult(result: AutomationRunNowResult): AutomationRunNowResult {
  return {
    occurrence: toPublicOccurrence(result.occurrence),
    outcome: result.outcome,
  }
}

function toAutomationOccurrenceView(
  options: Pick<RegisterAutomationRpcOptions, 'approvals' | 'runs'>,
  occurrence: AutomationOccurrenceRecord,
) {
  const run = occurrence.runId ? options.runs.findById(occurrence.runId) : null
  const pendingApprovalCount = run
    ? options.approvals.listPending(run.id).length
    : 0
  const effectiveStatus = run
    ? pendingApprovalCount > 0 && ['queued', 'running'].includes(run.status)
      ? 'awaiting_approval' as const
      : run.status
    : occurrence.status === 'bound' ? 'queued' : occurrence.status
  return {
    ...toPublicOccurrence(occurrence),
    automationName: occurrence.executionSnapshot.name,
    effectiveStatus,
    pendingApprovalCount,
    run: run
      ? {
          completedAt: run.completedAt,
          errorCode: run.errorCode,
          startedAt: run.startedAt,
          status: run.status,
        }
      : null,
  }
}

function toPublicOccurrence(
  occurrence: AutomationOccurrence | AutomationOccurrenceRecord,
): AutomationOccurrence {
  return {
    automationId: occurrence.automationId,
    automationRevision: occurrence.automationRevision,
    boundAt: occurrence.boundAt,
    coalescedMissedCount: occurrence.coalescedMissedCount,
    conversationId: occurrence.conversationId,
    errorCode: occurrence.errorCode,
    errorSummary: occurrence.errorSummary,
    finishedAt: occurrence.finishedAt,
    id: occurrence.id,
    queuedAt: occurrence.queuedAt,
    runId: occurrence.runId,
    scheduledFor: occurrence.scheduledFor,
    status: occurrence.status,
    triggerKind: occurrence.triggerKind,
  }
}
