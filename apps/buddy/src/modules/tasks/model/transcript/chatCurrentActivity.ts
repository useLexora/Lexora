import type { BuddyRunRetry } from '@buddy-shared/runs/runProgress'
import type { ChatAgentReasoningNode, ChatAgentToolNode, ChatAgentTurn } from './chatAgentTurn'
import type { BuddyI18nKey, BuddyLocale } from '@/i18n/buddyI18n'
import { translateBuddy } from '@/i18n/buddyI18n'
import { reasoningPreview } from './chatActivitySummary'
import { describeChatTool } from './chatToolDisplay'

export interface ChatCurrentActivity {
  label: string
  target: string
  detail: string
  retry?: BuddyRunRetry
  reasoning: ChatAgentReasoningNode | null
  tools: readonly ChatAgentToolNode[]
}

export function describeChatCurrentActivity(turn: ChatAgentTurn, language: BuddyLocale, now = Date.now()): ChatCurrentActivity | null {
  if (turn.status !== 'queued' && turn.status !== 'running')
    return null
  const running: ChatAgentToolNode[] = []
  const preparing: ChatAgentToolNode[] = []
  const approvals: ChatAgentToolNode[] = []
  let reasoning: ChatAgentReasoningNode | null = null
  let compacting = false
  for (const node of turn.nodes) {
    if (node.kind === 'tool') {
      if (node.status === 'running')
        running.push(node)
      else if (node.status === 'preparing')
        preparing.push(node)
      else if (node.status === 'awaiting_approval')
        approvals.push(node)
    }
    else if (node.kind === 'reasoning' && node.status === 'running') {
      reasoning = node
    }
    else if (node.kind === 'compaction' && node.status === 'running') {
      compacting = true
    }
  }
  const t = (key: BuddyI18nKey, params?: Record<string, string | number>) => translateBuddy(language, key, params)
  const tools = [...approvals, ...running, ...preparing]
  const activity: ChatCurrentActivity = { label: '', target: '', detail: '', reasoning: null, tools }
  if (approvals.length) {
    activity.label = t('desktop.chat.processAwaitingApproval')
    activity.detail = [
      running.length ? t('desktop.chat.activityRunningCount', { count: running.length }) : '',
      t('desktop.chat.activityApprovalCount', { count: approvals.length }),
      preparing.length ? t('desktop.chat.activityPreparingCount', { count: preparing.length }) : '',
    ].filter(Boolean).join(' · ')
    return activity
  }
  const retry = turn.progress?.retry
  if (retry) {
    const seconds = retry.retryAt ? Math.max(0, Math.ceil((Date.parse(retry.retryAt) - now) / 1000)) : 0
    return {
      ...activity,
      label: seconds > 0 ? t('desktop.chat.retryWaiting', { seconds }) : t('desktop.chat.retryRequesting'),
      retry,
      tools: [],
    }
  }
  if (compacting)
    return { ...activity, label: t('desktop.chat.compactionStarted') }
  if (running.length) {
    const single = running.length === 1 ? describeChatTool(running[0]!, language) : null
    activity.label = single
      ? t('desktop.chat.activityExecutingTool', { tool: single.label })
      : t('desktop.chat.activityExecutingCount', { count: running.length })
    activity.target = single && running[0]!.presentation.card !== 'terminal' ? single.target : ''
    activity.detail = preparing.length ? t('desktop.chat.activityPreparingCount', { count: preparing.length }) : ''
    return activity
  }
  if (preparing.length) {
    activity.label = t('desktop.chat.activityPreparingTools', { count: preparing.length })
    activity.target = preparing.length === 1 ? describeChatTool(preparing[0]!, language).label : ''
    return activity
  }
  if (reasoning)
    return { ...activity, label: t('desktop.chat.processReasoningRunning'), target: reasoningPreview(reasoning.text, true), reasoning }
  const progressLabels = {
    idle: 'desktop.chat.activity',
    awaiting_approval: 'desktop.chat.processAwaitingApproval',
    preparing: 'desktop.chat.progressPreparing',
    model_requesting: 'desktop.chat.progressModelRequesting',
    model_streaming: 'desktop.chat.progressModelStreaming',
    tool_executing: 'desktop.chat.progressToolExecuting',
  } as const satisfies Record<NonNullable<ChatAgentTurn['progress']>['phase'], BuddyI18nKey>
  return { ...activity, label: t(turn.progress ? progressLabels[turn.progress.phase] : 'desktop.chat.activity') }
}
