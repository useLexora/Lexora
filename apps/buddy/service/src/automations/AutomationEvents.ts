import type { Automation, AutomationOccurrence } from '../../../shared/automation'
import type { EventSnapshot } from '../../../shared/events/eventTypes'

export type AutomationFact = { automationId: string } & (
  | { kind: 'definition.created' | 'definition.updated' | 'definition.paused' | 'definition.resumed' | 'definition.deleted' | 'definition.blocked', definitionRevision: number }
  | { kind: 'schedule.advanced', nextRunAt: string | null, status: Automation['status'] }
  | { kind: 'occurrence.queued', occurrenceId: string, triggerKind: AutomationOccurrence['triggerKind'] }
  | { kind: 'occurrence.finished', occurrenceId: string, status: AutomationOccurrence['status'], errorCode: string | null }
  | { kind: 'occurrence.deleted', occurrenceId: string, conversationId: string | null, runId: string | null }
  | { kind: 'lease.acquired', occurrenceId: string, leaseOwner: string, leaseExpiresAt: string }
  | { kind: 'occurrence.bound', occurrenceId: string, conversationId: string, branchId: string, runId: string }
  | { kind: 'task.created' | 'branch.created' | 'run.queued', occurrenceId: string, conversationId: string, branchId: string, runId: string }
  | { kind: 'message.created', occurrenceId: string, conversationId: string, branchId: string, runId: string, messageId: string }
  | { kind: 'definition.last_run_changed', lastRunAt: string }
)

export type AutomationCommit = EventSnapshot<{
  operationId: string
  revision: number
  facts: readonly AutomationFact[]
}>

export function definitionFact(kind: Extract<AutomationFact, { definitionRevision: number }>['kind'], automation: Automation): AutomationFact {
  return { kind, automationId: automation.id, definitionRevision: automation.revision }
}

export function cancelledOccurrenceFacts(automationId: string, occurrenceIds: readonly string[]): AutomationFact[] {
  return occurrenceIds.map(occurrenceId => ({ kind: 'occurrence.finished', automationId, occurrenceId, status: 'cancelled', errorCode: null }))
}

export function occurrenceFact(occurrence: AutomationOccurrence): AutomationFact {
  return occurrence.status === 'queued'
    ? { kind: 'occurrence.queued', automationId: occurrence.automationId, occurrenceId: occurrence.id, triggerKind: occurrence.triggerKind }
    : { kind: 'occurrence.finished', automationId: occurrence.automationId, occurrenceId: occurrence.id, status: occurrence.status, errorCode: occurrence.errorCode }
}

export function affectsAutomationSchedule(commit: AutomationCommit): boolean {
  return commit.facts.some(fact => ('definitionRevision' in fact)
    || (fact.kind === 'occurrence.queued' && fact.triggerKind === 'manual'))
}
