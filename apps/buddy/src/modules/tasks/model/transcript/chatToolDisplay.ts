import type { ChatAgentToolNode } from './chatAgentTurn'
import type { BuddyI18nKey, BuddyLocale, BuddyTranslate } from '@/i18n/buddyI18n'
import { translateBuddy } from '@/i18n/buddyI18n'
import { translateSystemAction, translateSystemToolStatus } from '../approvals/systemActionPresentation'
import { getChatToolRegistration, isRegisteredChatTool } from './chatToolRegistry'

const automationLabels = {
  list: 'desktop.chat.processToolAutomationList',
  get: 'desktop.chat.processToolAutomationGet',
  upsert: 'desktop.chat.processToolAutomationUpsert',
  pause: 'desktop.chat.processToolAutomationPause',
  resume: 'desktop.chat.processToolAutomationResume',
  delete: 'desktop.chat.processToolAutomationDelete',
  run_now: 'desktop.chat.processToolAutomationRunNow',
} as const satisfies Record<string, BuddyI18nKey>

export function isChatToolActive(node: ChatAgentToolNode): boolean {
  return node.status === 'preparing' || node.status === 'running' || node.status === 'awaiting_approval'
}

export function isChatToolIssue(node: ChatAgentToolNode): boolean {
  return node.status === 'failed' || node.status === 'denied' || node.status === 'interrupted'
}

export function canExpandChatTool(node: ChatAgentToolNode, canPreviewFile?: (path: string) => boolean): boolean {
  const p = node.presentation
  return p.card === 'terminal'
    || (p.card === 'directory-authorization' && Boolean(p.requestedRoot || p.selectedRoot))
    || (p.card === 'image' && Boolean(p.prompt || p.reference || p.artifactIds.length))
    || (node.status !== 'denied' && 'output' in p && Boolean(p.output))
    || (node.status !== 'denied' && p.card === 'diff' && Boolean(p.diff))
    || (node.status !== 'denied' && !node.errorCode && (p.card === 'read' || p.card === 'diff') && canPreviewFile?.(p.path) === true)
}

export function describeChatTool(node: ChatAgentToolNode, language: BuddyLocale) {
  const t: BuddyTranslate = (key, params) => translateBuddy(language, key, params)
  const registration = getChatToolRegistration(node)
  const p = node.presentation
  if (!isRegisteredChatTool(node.toolName)) {
    const name = node.toolLabel && node.toolLabel !== node.toolName
      ? node.toolLabel
      : p.card === 'connector' ? p.tool : node.toolName
    return { label: t('tool.use'), icon: 'tool' as const, target: name, fullTarget: name, context: '', status: toolStatus(node, language, t) }
  }
  let label = t(registration.label)
  if (p.card === 'automation')
    label = t(automationLabels[p.operation])
  else if (p.card === 'system')
    label = translateSystemAction(language, p.action)

  const rawTarget = toolTarget(node, t)
  const target = rawTarget === label ? '' : rawTarget
  const path = p.card === 'read' || p.card === 'diff' ? splitDisplayPath(target) : null
  const skillName = registration.icon === 'skill' && path ? splitDisplayPath(path.directory.slice(0, -1)).name : null
  return {
    label,
    icon: registration.icon,
    target: skillName ?? path?.name ?? target,
    context: skillName ? '' : path?.directory ?? (p.card === 'search' && p.query ? p.path ?? '' : ''),
    fullTarget: [target, p.card === 'search' && p.query ? p.path : null].filter(Boolean).join(' · '),
    status: toolStatus(node, language, t),
  }
}

function splitDisplayPath(value: string): { name: string, directory: string } {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return index < 0 || index === value.length - 1
    ? { name: value, directory: '' }
    : { name: value.slice(index + 1), directory: value.slice(0, index + 1) }
}

function toolTarget(node: ChatAgentToolNode, t: BuddyTranslate): string {
  const p = node.presentation
  switch (p.card) {
    case 'terminal': return p.command
    case 'read':
    case 'diff': return p.path
    case 'search': return p.query || p.path || p.glob || ''
    case 'web': return p.target
    case 'connector': return p.connector
    case 'browser': return p.origin ?? ''
    case 'pet': return p.macro
    case 'image': return p.generatedCount === null ? '' : t('desktop.chat.processToolImageCount', { count: p.generatedCount })
    case 'automation': return p.name ?? (p.itemCount === null ? '' : t('desktop.chat.processToolAutomationCount', { count: p.itemCount }))
    case 'system': return ['action-expired', 'target-ambiguous', 'target-changed', 'target-not-found'].includes(p.status ?? '')
      ? ''
      : p.target ?? t('desktop.chat.processToolSystemTargetPending')
    case 'directory-authorization': return p.authorizedRoot ?? p.selectedRoot ?? p.requestedRoot ?? ''
    case 'generic': return node.description ?? p.description ?? ''
  }
}

function toolStatus(node: ChatAgentToolNode, language: BuddyLocale, t: BuddyTranslate): string {
  if (node.status === 'cancelled')
    return t('run.status.cancelled')
  if (node.status === 'skipped')
    return t('desktop.chat.processToolSkipped')
  if (node.errorCode === 'PATH_NOT_FOUND') {
    if (node.toolName === 'ls' || node.toolName === 'find')
      return t('desktop.chat.processToolDirectoryNotFound')
    return t(node.presentation.card === 'read' || node.presentation.card === 'diff'
      ? 'desktop.chat.processToolFileNotFound'
      : 'desktop.chat.processToolPathNotFound')
  }
  if (node.errorCode === 'INVALID_PATH')
    return t('desktop.chat.processToolInvalidPath')
  if (node.errorCode === 'VALIDATION_FAILED')
    return t('desktop.chat.processToolInvalidInput')
  if (node.denialCode === 'READ_ONLY_PROFILE')
    return t('desktop.chat.toolDeniedReadOnly')
  if (node.status === 'awaiting_approval')
    return t('desktop.chat.processAwaitingApproval')
  if (node.status === 'denied')
    return t('desktop.chat.processToolApprovalDenied')
  if (node.status === 'interrupted')
    return t('desktop.chat.processToolInterrupted')
  if (node.status === 'preparing')
    return t('desktop.chat.processToolPreparing')
  if (node.status === 'running')
    return t('desktop.chat.processToolRunning')
  const p = node.presentation
  if (p.card === 'system')
    return translateSystemToolStatus(language, p.status)
  if (node.status === 'failed') {
    return p.card === 'terminal' && p.exitCode !== null
      ? t('desktop.chat.processToolExitCode', { code: p.exitCode })
      : t('desktop.chat.processToolFailed')
  }
  if (p.card === 'directory-authorization') {
    if (p.requestSatisfied === false)
      return t('desktop.chat.processToolDirectoryRequestUnsatisfied')
    if (p.status === 'cancelled')
      return t('desktop.chat.processToolDirectoryAuthorizationCancelled')
    if (p.status === 'failed')
      return t('desktop.chat.processToolDirectoryAuthorizationFailed')
    if (p.status === 'scope-changed')
      return t('desktop.chat.processToolDirectoryScopeChanged')
    if (p.grantStatus === 'expanded')
      return t('desktop.chat.processToolDirectoryExpanded')
  }
  return t('tool.completed')
}
