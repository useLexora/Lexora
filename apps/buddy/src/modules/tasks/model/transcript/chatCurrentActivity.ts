import type { BuddyRunRetry } from '@buddy-shared/runs/runProgress'
import type { ChatAgentTurn } from './chatAgentTurn'
import type { BuddyI18nKey, BuddyLocale } from '@/i18n/buddyI18n'
import { translateBuddy } from '@/i18n/buddyI18n'

export interface ChatCurrentActivity {
  label: string
  active: boolean
  warning?: boolean
  retry?: BuddyRunRetry
}

export function describeChatCurrentActivity(turn: ChatAgentTurn, language: BuddyLocale, now = Date.now(), stopping = false): ChatCurrentActivity | null {
  if (turn.status !== 'queued' && turn.status !== 'running')
    return null
  const t = (key: BuddyI18nKey, params?: Record<string, string | number>) => translateBuddy(language, key, params)
  if (stopping)
    return { label: t('desktop.chat.progressStopping'), active: false }
  if (turn.status === 'queued')
    return { label: t('desktop.chat.progressQueued'), active: false }
  if (turn.nodes.some(node => node.kind === 'tool' && node.status === 'awaiting_approval') || turn.progress?.phase === 'awaiting_approval')
    return { label: t('desktop.chat.progressApproval'), active: false, warning: true }
  const retry = turn.progress?.retry
  if (retry) {
    const seconds = retry.retryAt ? Math.max(0, Math.ceil((Date.parse(retry.retryAt) - now) / 1000)) : 0
    return {
      label: seconds > 0 ? t('desktop.chat.retryWaiting', { seconds }) : t('desktop.chat.retryRequesting'),
      active: retry.retryAt === null,
      warning: true,
      retry,
    }
  }
  if (turn.nodes.some(node => node.kind === 'compaction' && node.status === 'running'))
    return { label: t('desktop.chat.compactionStarted'), active: true }
  if (turn.nodes.some(node => node.kind === 'tool' && node.status === 'running'))
    return { label: t('desktop.chat.progressToolExecuting'), active: true }
  if (turn.nodes.some(node => node.kind === 'tool' && node.status === 'preparing'))
    return { label: t('desktop.chat.progressPreparing'), active: true }
  if (turn.nodes.some(node => node.kind === 'reasoning' && node.status === 'running'))
    return { label: t('desktop.chat.processReasoningRunning'), active: true }
  const progressLabels = {
    idle: 'desktop.chat.activity',
    awaiting_approval: 'desktop.chat.progressApproval',
    preparing: 'desktop.chat.progressPreparing',
    model_requesting: 'desktop.chat.progressModelRequesting',
    model_streaming: 'desktop.chat.activity',
    model_thinking: 'desktop.chat.processReasoningRunning',
    model_responding: 'desktop.chat.progressModelResponding',
    tool_executing: 'desktop.chat.activity',
  } as const satisfies Record<NonNullable<ChatAgentTurn['progress']>['phase'], BuddyI18nKey>
  return { label: t(turn.progress ? progressLabels[turn.progress.phase] : 'desktop.chat.activity'), active: true }
}
