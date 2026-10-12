import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyI18nKey, BuddyLocale } from '@/i18n/buddyI18n'
import { translateBuddy } from '@/i18n/buddyI18n'
import { executionLabels } from './executionLabels'

export function executionPriority(execution: LocalExecution): number {
  if (execution.questions.some(question => question.open && question.audience === 'user') || execution.waitingFor === 'approval')
    return 0
  if (execution.cleanup === 'degraded' || execution.status === 'failed')
    return 1
  return execution.phase === 'closed' ? 3 : 2
}

export function executionStatus(execution: LocalExecution, language: BuddyLocale, now = Date.now()): string {
  const labels = executionLabels(language)
  if (execution.stopping)
    return labels.stopping
  if (execution.phase === 'closing')
    return labels.closing
  if (['completed', 'failed', 'cancelled'].includes(execution.status))
    return labels[execution.status as 'completed' | 'failed' | 'cancelled']
  if (execution.waitingFor === 'answer')
    return execution.questions.some(question => question.open && question.audience === 'user') ? labels.waitingAnswer : labels.waitingCaller
  if (execution.waitingFor === 'approval')
    return labels.waitingApproval
  if (execution.waitingFor === 'resource')
    return labels.waitingResource
  if (execution.waitingFor === 'children')
    return labels.waitingChildren.replace('{count}', String(execution.activeChildren))
  if (execution.phase !== 'working' || execution.status === 'queued' || !execution.progress)
    return labels[execution.phase === 'closed' ? 'completed' : execution.phase]
  const retry = execution.progress.retry
  if (retry) {
    const seconds = retry.retryAt ? Math.max(0, Math.ceil((Date.parse(retry.retryAt) - now) / 1000)) : 0
    return translateBuddy(language, seconds ? 'desktop.chat.retryWaiting' : 'desktop.chat.retryRequesting', { seconds })
  }
  const keys = {
    idle: 'desktop.chat.activity',
    model_requesting: 'desktop.chat.progressModelRequesting',
    model_streaming: 'desktop.chat.activity',
    model_thinking: 'desktop.chat.processReasoningRunning',
    model_responding: 'desktop.chat.progressModelResponding',
    preparing: 'desktop.chat.progressPreparing',
    awaiting_approval: 'desktop.chat.progressApproval',
    tool_executing: 'desktop.chat.progressToolExecuting',
  } as const satisfies Record<NonNullable<LocalExecution['progress']>['phase'], BuddyI18nKey>
  const action = translateBuddy(language, keys[execution.progress.phase])
  return execution.progress.phase === 'tool_executing' && execution.progress.toolName ? `${action} · ${execution.progress.toolName}` : action
}

export function executionPhaseLabel(execution: LocalExecution, language: BuddyLocale, now = Date.now()): string {
  const labels = executionLabels(language)
  if (execution.stopping)
    return labels.stopping
  if (execution.phase === 'closing')
    return labels.closing
  if (execution.phase === 'closed')
    return executionStatus(execution, language)
  if (execution.waitingFor)
    return labels.waiting
  if (execution.status === 'running' && execution.phase === 'working' && execution.progress?.retry) {
    const retryAt = execution.progress.retry.retryAt
    return retryAt && Date.parse(retryAt) > now ? labels.retryWaiting : labels.retrying
  }
  return labels[execution.phase]
}
